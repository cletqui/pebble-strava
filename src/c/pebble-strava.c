#include <pebble.h>

// === Action / sport / upload constants ===

#define CMD_START   0
#define CMD_STOP    1
#define CMD_PAUSE   2
#define CMD_RESUME  3

#define SPORT_RUNNING 0
#define SPORT_CYCLING 1

#define UPLOAD_PENDING 0
#define UPLOAD_SUCCESS 1
#define UPLOAD_ERROR   2

#define HR_SEND_EVERY 5  // send HR to phone every N timer ticks

// === App state ===

typedef enum {
  STATE_SELECT,
  STATE_ACTIVE,
  STATE_PAUSED,
  STATE_UPLOADING,
  STATE_DONE,
} AppState;

static AppState s_state = STATE_SELECT;
static int      s_sport = SPORT_RUNNING;

static uint32_t s_elapsed_secs = 0;
static uint32_t s_distance_m   = 0;
static uint32_t s_speed_cms    = 0;  // centimeters/sec from phone GPS
static int16_t  s_hr_bpm       = 0;
static bool     s_gps_fix      = false;

static int       s_hr_tick   = 0;
static bool      s_back_armed = false;
static AppTimer *s_back_timer   = NULL;
static AppTimer *s_workout_timer = NULL;

// === Windows & layers ===

static Window    *s_select_win;
static TextLayer *s_sel_title;
static TextLayer *s_sel_sport;
static TextLayer *s_sel_hint;

static Window    *s_workout_win;
static TextLayer *s_wk_hr;
static TextLayer *s_wk_time;
static TextLayer *s_wk_dist;
static TextLayer *s_wk_speed;
static TextLayer *s_wk_bottom;

// Persistent display buffers (TextLayer holds pointer, not a copy)
static char s_sel_sport_buf[16];
static char s_wk_hr_buf[24];
static char s_wk_time_buf[16];
static char s_wk_dist_buf[20];
static char s_wk_speed_buf[24];
static char s_wk_bottom_buf[40];

// === Formatting ===

static void fmt_time(char *buf, size_t n, uint32_t secs) {
  unsigned long h = secs / 3600;
  unsigned long m = (secs % 3600) / 60;
  unsigned long s = secs % 60;
  if (h > 0) snprintf(buf, n, "%lu:%02lu:%02lu", h, m, s);
  else        snprintf(buf, n, "%02lu:%02lu", m, s);
}

static void fmt_dist(char *buf, size_t n, uint32_t m) {
  if (m < 1000) {
    snprintf(buf, n, "%lu m", (unsigned long)m);
  } else {
    unsigned long km  = m / 1000;
    unsigned long dec = (m % 1000) / 10;
    snprintf(buf, n, "%lu.%02lu km", km, dec);
  }
}

static void fmt_speed(char *buf, size_t n, uint32_t cms, int sport) {
  if (cms < 10) {
    snprintf(buf, n, sport == SPORT_CYCLING ? "0.0 km/h" : "--:-- /km");
    return;
  }
  if (sport == SPORT_CYCLING) {
    // cms * 3600 / 100000 = cms * 36 / 1000
    unsigned long i = (cms * 36) / 1000;
    unsigned long d = ((cms * 36) % 1000) / 10;
    snprintf(buf, n, "%lu.%02lu km/h", i, d);
  } else {
    // seconds per km = 100000 / cms
    unsigned long spk = 100000 / cms;
    snprintf(buf, n, "%lu:%02lu /km", spk / 60, spk % 60);
  }
}

// Forward declaration needed because prv_inbox_received calls update_workout_display
// before it is defined (GPS display refresh on receipt rather than waiting for timer tick)
static void update_workout_display(void);

// === AppMessage ===

static void prv_inbox_received(DictionaryIterator *iter, void *ctx) {
  Tuple *t;
  bool gps_updated = false;

  t = dict_find(iter, MESSAGE_KEY_GPS_DISTANCE);
  if (t) { s_distance_m = (uint32_t)t->value->int32; gps_updated = true; }

  t = dict_find(iter, MESSAGE_KEY_GPS_SPEED);
  if (t) { s_speed_cms = (uint32_t)t->value->int32; gps_updated = true; }

  t = dict_find(iter, MESSAGE_KEY_GPS_HAS_FIX);
  if (t) { s_gps_fix = (bool)t->value->int8; gps_updated = true; }

  // Refresh display immediately on GPS update so distance/speed don't lag
  if (gps_updated && s_workout_win == window_stack_get_top_window()) {
    update_workout_display();
  }

  t = dict_find(iter, MESSAGE_KEY_UPLOAD_STATUS);
  if (t) {
    int status = (int)t->value->int8;
    if (status == UPLOAD_SUCCESS) {
      s_state = STATE_DONE;
      snprintf(s_wk_bottom_buf, sizeof(s_wk_bottom_buf), "Saved! BACK to exit");
      APP_LOG(APP_LOG_LEVEL_INFO, "Upload succeeded");
      vibes_double_pulse();
    } else if (status == UPLOAD_ERROR) {
      s_state = STATE_DONE;
      Tuple *msg = dict_find(iter, MESSAGE_KEY_UPLOAD_MSG);
      if (msg) snprintf(s_wk_bottom_buf, sizeof(s_wk_bottom_buf), "Error: %.24s", msg->value->cstring);
      else     snprintf(s_wk_bottom_buf, sizeof(s_wk_bottom_buf), "Upload failed");
      APP_LOG(APP_LOG_LEVEL_ERROR, "Upload error: %s", s_wk_bottom_buf);
      vibes_long_pulse();
    }
    if (s_workout_win == window_stack_get_top_window()) {
      text_layer_set_text(s_wk_bottom, s_wk_bottom_buf);
    }
  }
}

static void prv_send_cmd(int action) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) return;
  dict_write_int8(iter, MESSAGE_KEY_CMD_ACTION, (int8_t)action);
  if (action == CMD_START) {
    dict_write_int8(iter, MESSAGE_KEY_CMD_SPORT, (int8_t)s_sport);
  }
  app_message_outbox_send();
}

static void prv_send_hr(void) {
  if (s_hr_bpm <= 0) return;
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) return;
  dict_write_int16(iter, MESSAGE_KEY_HR_BPM, s_hr_bpm);
  app_message_outbox_send();
}

// === HR reading ===

static void prv_read_hr(void) {
  HealthServiceAccessibilityMask mask = health_service_metric_accessible(
    HealthMetricHeartRateBPM, time(NULL), time(NULL));
  if (mask & HealthServiceAccessibilityMaskAvailable) {
    HealthValue hr = health_service_peek_current_value(HealthMetricHeartRateBPM);
    if (hr > 0) s_hr_bpm = (int16_t)hr;
  }
}

// === Workout display ===

static void update_workout_display(void) {
  // HR + GPS status
  char gps = s_gps_fix ? 'Y' : 'N';
  if (s_hr_bpm > 0) snprintf(s_wk_hr_buf,    sizeof(s_wk_hr_buf),    "%d bpm  GPS:%c", s_hr_bpm, gps);
  else              snprintf(s_wk_hr_buf,    sizeof(s_wk_hr_buf),    "-- bpm  GPS:%c", gps);

  fmt_time(s_wk_time_buf,  sizeof(s_wk_time_buf),  s_elapsed_secs);
  fmt_dist(s_wk_dist_buf,  sizeof(s_wk_dist_buf),  s_distance_m);
  fmt_speed(s_wk_speed_buf, sizeof(s_wk_speed_buf), s_speed_cms, s_sport);

  switch (s_state) {
    case STATE_ACTIVE:
      snprintf(s_wk_bottom_buf, sizeof(s_wk_bottom_buf), "SEL:pause  BACK x2:stop");
      break;
    case STATE_PAUSED:
      snprintf(s_wk_bottom_buf, sizeof(s_wk_bottom_buf), "PAUSED  SEL:resume");
      break;
    case STATE_UPLOADING:
      snprintf(s_wk_bottom_buf, sizeof(s_wk_bottom_buf), "Uploading to Strava...");
      break;
    default:
      break;
  }

  text_layer_set_text(s_wk_hr,     s_wk_hr_buf);
  text_layer_set_text(s_wk_time,   s_wk_time_buf);
  text_layer_set_text(s_wk_dist,   s_wk_dist_buf);
  text_layer_set_text(s_wk_speed,  s_wk_speed_buf);
  text_layer_set_text(s_wk_bottom, s_wk_bottom_buf);
}

// === Workout timer (1 Hz) ===

static void prv_tick(void *ctx) {
  if (s_state != STATE_ACTIVE) return;

  s_elapsed_secs++;
  s_hr_tick++;

  if (s_hr_tick >= HR_SEND_EVERY) {
    s_hr_tick = 0;
    prv_read_hr();
    prv_send_hr();
  }

  update_workout_display();
  s_workout_timer = app_timer_register(1000, prv_tick, NULL);
}

static void start_timer(void) {
  if (s_workout_timer) app_timer_cancel(s_workout_timer);
  s_workout_timer = app_timer_register(1000, prv_tick, NULL);
}

static void stop_timer(void) {
  if (s_workout_timer) {
    app_timer_cancel(s_workout_timer);
    s_workout_timer = NULL;
  }
}

// === Workout actions ===

static void action_start(void) {
  s_state        = STATE_ACTIVE;
  s_elapsed_secs = 0;
  s_distance_m   = 0;
  s_speed_cms    = 0;
  s_hr_bpm       = 0;
  s_gps_fix      = false;
  s_hr_tick      = 0;

  prv_read_hr();
  prv_send_cmd(CMD_START);
  start_timer();

  APP_LOG(APP_LOG_LEVEL_INFO, "Workout started: sport=%d", s_sport);
  // prv_workout_load calls update_workout_display() on push
  window_stack_push(s_workout_win, true);
}

static void action_pause(void) {
  APP_LOG(APP_LOG_LEVEL_INFO, "Paused at %lus", (unsigned long)s_elapsed_secs);
  s_state = STATE_PAUSED;
  stop_timer();
  prv_send_cmd(CMD_PAUSE);
  update_workout_display();
  vibes_short_pulse();
}

static void action_resume(void) {
  APP_LOG(APP_LOG_LEVEL_INFO, "Resumed");
  s_state = STATE_ACTIVE;
  prv_send_cmd(CMD_RESUME);
  start_timer();
  update_workout_display();
  vibes_short_pulse();
}

static void action_stop(void) {
  APP_LOG(APP_LOG_LEVEL_INFO, "Stopped: elapsed=%lus dist=%lum", (unsigned long)s_elapsed_secs, (unsigned long)s_distance_m);
  s_state = STATE_UPLOADING;
  stop_timer();
  prv_send_cmd(CMD_STOP);
  update_workout_display();
  vibes_long_pulse();
}

// === Double-BACK timer ===

static void prv_back_timer_cb(void *ctx) {
  s_back_armed = false;
  s_back_timer = NULL;
  if (s_state == STATE_ACTIVE || s_state == STATE_PAUSED) {
    snprintf(s_wk_bottom_buf, sizeof(s_wk_bottom_buf),
             s_state == STATE_ACTIVE ? "SEL:pause  BACK x2:stop" : "PAUSED  SEL:resume");
    text_layer_set_text(s_wk_bottom, s_wk_bottom_buf);
  }
}

// === Click handlers — Workout window ===

static void prv_wk_select(ClickRecognizerRef r, void *ctx) {
  if (s_state == STATE_ACTIVE)    action_pause();
  else if (s_state == STATE_PAUSED)  action_resume();
  else if (s_state == STATE_DONE)    window_stack_pop(true);
}

static void prv_wk_up(ClickRecognizerRef r, void *ctx) {
  if (s_state == STATE_ACTIVE) vibes_short_pulse();  // lap marker feedback
}

static void prv_wk_back(ClickRecognizerRef r, void *ctx) {
  if (s_state == STATE_DONE) {
    window_stack_pop(true);
    return;
  }
  if (s_state == STATE_UPLOADING) return;

  if (s_back_armed) {
    if (s_back_timer) { app_timer_cancel(s_back_timer); s_back_timer = NULL; }
    s_back_armed = false;
    action_stop();
  } else {
    s_back_armed = true;
    snprintf(s_wk_bottom_buf, sizeof(s_wk_bottom_buf), "Press BACK again to stop");
    text_layer_set_text(s_wk_bottom, s_wk_bottom_buf);
    s_back_timer = app_timer_register(3000, prv_back_timer_cb, NULL);
  }
}

static void prv_wk_click_config(void *ctx) {
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_wk_select);
  window_single_click_subscribe(BUTTON_ID_UP,     prv_wk_up);
  window_single_click_subscribe(BUTTON_ID_BACK,   prv_wk_back);
}

// === Click handlers — Sport select window ===

static void prv_update_sport_label(void) {
  snprintf(s_sel_sport_buf, sizeof(s_sel_sport_buf),
           s_sport == SPORT_RUNNING ? "RUNNING" : "CYCLING");
  text_layer_set_text(s_sel_sport, s_sel_sport_buf);
}

static void prv_sel_up(ClickRecognizerRef r, void *ctx) {
  s_sport = SPORT_RUNNING;
  prv_update_sport_label();
}

static void prv_sel_down(ClickRecognizerRef r, void *ctx) {
  s_sport = SPORT_CYCLING;
  prv_update_sport_label();
}

static void prv_sel_select(ClickRecognizerRef r, void *ctx) {
  action_start();
}

static void prv_sel_click_config(void *ctx) {
  window_single_click_subscribe(BUTTON_ID_UP,     prv_sel_up);
  window_single_click_subscribe(BUTTON_ID_DOWN,   prv_sel_down);
  window_single_click_subscribe(BUTTON_ID_SELECT, prv_sel_select);
}

// === Sport select window ===

static void prv_select_load(Window *win) {
  Layer  *root   = window_get_root_layer(win);
  GRect   bounds = layer_get_bounds(root);
  int     w      = bounds.size.w;

  s_sel_title = text_layer_create(GRect(0, 28, w, 30));
  text_layer_set_text(s_sel_title, "SELECT SPORT");
  text_layer_set_text_alignment(s_sel_title, GTextAlignmentCenter);
  text_layer_set_font(s_sel_title, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_background_color(s_sel_title, GColorClear);
  text_layer_set_text_color(s_sel_title, GColorWhite);
  layer_add_child(root, text_layer_get_layer(s_sel_title));

  s_sel_sport = text_layer_create(GRect(0, 84, w, 56));
  prv_update_sport_label();
  text_layer_set_text_alignment(s_sel_sport, GTextAlignmentCenter);
  text_layer_set_font(s_sel_sport, fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD));
  text_layer_set_background_color(s_sel_sport, GColorClear);
  text_layer_set_text_color(s_sel_sport, GColorOrange);
  layer_add_child(root, text_layer_get_layer(s_sel_sport));

  s_sel_hint = text_layer_create(GRect(4, 184, w - 8, 40));
  text_layer_set_text(s_sel_hint, "UP:Run  DOWN:Cycle  SEL:Go");
  text_layer_set_text_alignment(s_sel_hint, GTextAlignmentCenter);
  text_layer_set_font(s_sel_hint, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_background_color(s_sel_hint, GColorClear);
  text_layer_set_text_color(s_sel_hint, GColorLightGray);
  layer_add_child(root, text_layer_get_layer(s_sel_hint));
}

static void prv_select_unload(Window *win) {
  text_layer_destroy(s_sel_title);
  text_layer_destroy(s_sel_sport);
  text_layer_destroy(s_sel_hint);
}

// === Workout window ===

static void prv_workout_load(Window *win) {
  Layer *root   = window_get_root_layer(win);
  GRect  bounds = layer_get_bounds(root);
  int    w      = bounds.size.w;

  // HR + GPS status (top)
  s_wk_hr = text_layer_create(GRect(0, 4, w, 22));
  text_layer_set_text_alignment(s_wk_hr, GTextAlignmentCenter);
  text_layer_set_font(s_wk_hr, fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
  text_layer_set_background_color(s_wk_hr, GColorClear);
  text_layer_set_text_color(s_wk_hr, GColorOrange);
  layer_add_child(root, text_layer_get_layer(s_wk_hr));

  // Elapsed time (large, center)
  s_wk_time = text_layer_create(GRect(0, 32, w, 56));
  text_layer_set_text_alignment(s_wk_time, GTextAlignmentCenter);
  text_layer_set_font(s_wk_time, fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD));
  text_layer_set_background_color(s_wk_time, GColorClear);
  text_layer_set_text_color(s_wk_time, GColorWhite);
  layer_add_child(root, text_layer_get_layer(s_wk_time));

  // Distance
  s_wk_dist = text_layer_create(GRect(0, 100, w, 36));
  text_layer_set_text_alignment(s_wk_dist, GTextAlignmentCenter);
  text_layer_set_font(s_wk_dist, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  text_layer_set_background_color(s_wk_dist, GColorClear);
  text_layer_set_text_color(s_wk_dist, GColorWhite);
  layer_add_child(root, text_layer_get_layer(s_wk_dist));

  // Speed / pace
  s_wk_speed = text_layer_create(GRect(0, 138, w, 36));
  text_layer_set_text_alignment(s_wk_speed, GTextAlignmentCenter);
  text_layer_set_font(s_wk_speed, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  text_layer_set_background_color(s_wk_speed, GColorClear);
  text_layer_set_text_color(s_wk_speed, GColorOrange);
  layer_add_child(root, text_layer_get_layer(s_wk_speed));

  // Bottom hint / state
  s_wk_bottom = text_layer_create(GRect(4, 190, w - 8, 36));
  text_layer_set_text_alignment(s_wk_bottom, GTextAlignmentCenter);
  text_layer_set_font(s_wk_bottom, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  text_layer_set_background_color(s_wk_bottom, GColorClear);
  text_layer_set_text_color(s_wk_bottom, GColorLightGray);
  layer_add_child(root, text_layer_get_layer(s_wk_bottom));

  update_workout_display();
}

static void prv_workout_unload(Window *win) {
  text_layer_destroy(s_wk_hr);
  text_layer_destroy(s_wk_time);
  text_layer_destroy(s_wk_dist);
  text_layer_destroy(s_wk_speed);
  text_layer_destroy(s_wk_bottom);
}

// === Init / Deinit ===

static void prv_init(void) {
  s_select_win = window_create();
  window_set_background_color(s_select_win, GColorBlack);
  window_set_click_config_provider(s_select_win, prv_sel_click_config);
  window_set_window_handlers(s_select_win, (WindowHandlers){
    .load   = prv_select_load,
    .unload = prv_select_unload,
  });

  s_workout_win = window_create();
  window_set_background_color(s_workout_win, GColorBlack);
  window_set_click_config_provider(s_workout_win, prv_wk_click_config);
  window_set_window_handlers(s_workout_win, (WindowHandlers){
    .load   = prv_workout_load,
    .unload = prv_workout_unload,
  });

  app_message_open(512, 256);
  app_message_register_inbox_received(prv_inbox_received);

  window_stack_push(s_select_win, false);
}

static void prv_deinit(void) {
  stop_timer();
  window_destroy(s_select_win);
  window_destroy(s_workout_win);
}

int main(void) {
  prv_init();
  app_event_loop();
  prv_deinit();
}
