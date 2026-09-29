# Before / after request evidence

All omitted methods are zero; no production traffic. A-H use the frozen protocol in AUDIT.md. Cloud totals include uniIdCo.setPushCid and exclude the local Push CID API. Success-path registerMobileDevice has exactly one business mobile-device insert/update. Budgets are executed service-path proxies; page lifecycle ordering and Pairing ticks are explicitly modeled. They do not measure device energy, wall-clock responsiveness, SDK-internal traffic or database query plans.

## Scenario A

| Method | Before | After | Reduction |
|---|---:|---:|---:|
| bootstrap | 0 | 0 | 0 |
| getPrivacyConsent | 2 | 1 | 1 |
| getDashboard | 1 | 0 | 1 |
| getAndroidDashboard | 0 | 1 | -1 |
| getSettings | 0 | 0 | 0 |
| listTasks | 1 | 0 | 1 |
| listDesktops | 1 | 0 | 1 |
| getPushClientId | 1 | 1 | 0 |
| setPushCid | 1 | 1 | 0 |
| registerMobileDevice | 1 | 1 | 0 |
| updateSettings | 0 | 0 | 0 |
| createPairingCode | 0 | 0 | 0 |
| getPairingStatus | 0 | 0 | 0 |
| TOTAL_CLOUD_RPC | 7 | 4 | 3 |
| MOBILE_DEVICE_DB_WRITE | 1 | 1 | 0 |

CACHE before: {"miss":2}; after: {"miss":1}. TIMERS before/after: {"local":0,"remote":0}.

## Scenario B

| Method | Before | After | Reduction |
|---|---:|---:|---:|
| bootstrap | 0 | 0 | 0 |
| getPrivacyConsent | 2 | 0 | 2 |
| getDashboard | 1 | 0 | 1 |
| getAndroidDashboard | 0 | 0 | 0 |
| getSettings | 0 | 0 | 0 |
| listTasks | 1 | 0 | 1 |
| listDesktops | 1 | 0 | 1 |
| getPushClientId | 1 | 0 | 1 |
| setPushCid | 1 | 0 | 1 |
| registerMobileDevice | 1 | 0 | 1 |
| updateSettings | 0 | 0 | 0 |
| createPairingCode | 0 | 0 | 0 |
| getPairingStatus | 0 | 0 | 0 |
| TOTAL_CLOUD_RPC | 7 | 0 | 7 |
| MOBILE_DEVICE_DB_WRITE | 1 | 0 | 1 |

CACHE before: {"stale":2}; after: {"hit":1}. TIMERS before/after: {"local":0,"remote":0}.

## Scenario C

| Method | Before | After | Reduction |
|---|---:|---:|---:|
| bootstrap | 0 | 0 | 0 |
| getPrivacyConsent | 2 | 1 | 1 |
| getDashboard | 1 | 0 | 1 |
| getAndroidDashboard | 0 | 1 | -1 |
| getSettings | 0 | 0 | 0 |
| listTasks | 1 | 0 | 1 |
| listDesktops | 1 | 0 | 1 |
| getPushClientId | 1 | 1 | 0 |
| setPushCid | 1 | 0 | 1 |
| registerMobileDevice | 1 | 0 | 1 |
| updateSettings | 0 | 0 | 0 |
| createPairingCode | 0 | 0 | 0 |
| getPairingStatus | 0 | 0 | 0 |
| TOTAL_CLOUD_RPC | 7 | 2 | 5 |
| MOBILE_DEVICE_DB_WRITE | 1 | 0 | 1 |

CACHE before: {"stale":2}; after: {"stale":1}. TIMERS before/after: {"local":0,"remote":0}.

## Scenario D

| Method | Before | After | Reduction |
|---|---:|---:|---:|
| bootstrap | 0 | 0 | 0 |
| getPrivacyConsent | 5 | 0 | 5 |
| getDashboard | 2 | 0 | 2 |
| getAndroidDashboard | 0 | 0 | 0 |
| getSettings | 0 | 0 | 0 |
| listTasks | 2 | 1 | 1 |
| listDesktops | 3 | 1 | 2 |
| getPushClientId | 0 | 0 | 0 |
| setPushCid | 0 | 0 | 0 |
| registerMobileDevice | 0 | 0 | 0 |
| updateSettings | 0 | 0 | 0 |
| createPairingCode | 0 | 0 | 0 |
| getPairingStatus | 0 | 0 | 0 |
| TOTAL_CLOUD_RPC | 12 | 2 | 10 |
| MOBILE_DEVICE_DB_WRITE | 0 | 0 | 0 |

CACHE before: {"hit":1,"miss":1,"stale":5}; after: {"hit":4,"miss":2}. TIMERS before/after: {"local":0,"remote":0}.

## Scenario E

| Method | Before | After | Reduction |
|---|---:|---:|---:|
| bootstrap | 0 | 0 | 0 |
| getPrivacyConsent | 1 | 0 | 1 |
| getDashboard | 1 | 0 | 1 |
| getAndroidDashboard | 0 | 1 | -1 |
| getSettings | 0 | 0 | 0 |
| listTasks | 1 | 0 | 1 |
| listDesktops | 1 | 0 | 1 |
| getPushClientId | 0 | 0 | 0 |
| setPushCid | 0 | 0 | 0 |
| registerMobileDevice | 0 | 0 | 0 |
| updateSettings | 0 | 0 | 0 |
| createPairingCode | 0 | 0 | 0 |
| getPairingStatus | 0 | 0 | 0 |
| TOTAL_CLOUD_RPC | 4 | 1 | 3 |
| MOBILE_DEVICE_DB_WRITE | 0 | 0 | 0 |

CACHE before: {"stale":2}; after: {"stale":1}. TIMERS before/after: {"local":0,"remote":0}.

## Scenario F

| Method | Before | After | Reduction |
|---|---:|---:|---:|
| bootstrap | 0 | 0 | 0 |
| getPrivacyConsent | 0 | 0 | 0 |
| getDashboard | 0 | 0 | 0 |
| getAndroidDashboard | 0 | 0 | 0 |
| getSettings | 0 | 0 | 0 |
| listTasks | 0 | 0 | 0 |
| listDesktops | 0 | 0 | 0 |
| getPushClientId | 0 | 0 | 0 |
| setPushCid | 0 | 0 | 0 |
| registerMobileDevice | 0 | 0 | 0 |
| updateSettings | 0 | 0 | 0 |
| createPairingCode | 0 | 0 | 0 |
| getPairingStatus | 0 | 0 | 0 |
| TOTAL_CLOUD_RPC | 0 | 0 | 0 |
| MOBILE_DEVICE_DB_WRITE | 0 | 0 | 0 |

CACHE before: {}; after: {}. TIMERS before/after: {"local":0,"remote":0}.

## Scenario G

| Method | Before | After | Reduction |
|---|---:|---:|---:|
| bootstrap | 0 | 0 | 0 |
| getPrivacyConsent | 2 | 0 | 2 |
| getDashboard | 0 | 0 | 0 |
| getAndroidDashboard | 0 | 0 | 0 |
| getSettings | 0 | 0 | 0 |
| listTasks | 0 | 0 | 0 |
| listDesktops | 0 | 0 | 0 |
| getPushClientId | 1 | 0 | 1 |
| setPushCid | 1 | 0 | 1 |
| registerMobileDevice | 1 | 0 | 1 |
| updateSettings | 0 | 0 | 0 |
| createPairingCode | 0 | 0 | 0 |
| getPairingStatus | 0 | 0 | 0 |
| TOTAL_CLOUD_RPC | 4 | 0 | 4 |
| MOBILE_DEVICE_DB_WRITE | 1 | 0 | 1 |

CACHE before: {"hit":2}; after: {"hit":2}. TIMERS before/after: {"local":0,"remote":0}.

## Scenario H

| Method | Before | After | Reduction |
|---|---:|---:|---:|
| bootstrap | 0 | 0 | 0 |
| getPrivacyConsent | 1 | 0 | 1 |
| getDashboard | 0 | 0 | 0 |
| getAndroidDashboard | 0 | 0 | 0 |
| getSettings | 0 | 0 | 0 |
| listTasks | 0 | 0 | 0 |
| listDesktops | 0 | 0 | 0 |
| getPushClientId | 0 | 0 | 0 |
| setPushCid | 0 | 0 | 0 |
| registerMobileDevice | 0 | 0 | 0 |
| updateSettings | 0 | 0 | 0 |
| createPairingCode | 1 | 1 | 0 |
| getPairingStatus | 12 | 12 | 0 |
| TOTAL_CLOUD_RPC | 14 | 13 | 1 |
| MOBILE_DEVICE_DB_WRITE | 0 | 0 | 0 |

CACHE before: {}; after: {}. TIMERS before/after: {"local":1,"remote":1}.

