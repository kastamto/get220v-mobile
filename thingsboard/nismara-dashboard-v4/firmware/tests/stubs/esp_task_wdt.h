#pragma once
typedef struct{int timeout_ms;int idle_core_mask;bool trigger_panic;}esp_task_wdt_config_t;
int esp_task_wdt_init(int,bool); int esp_task_wdt_add(void*); int esp_task_wdt_reset();
