# Logs Analysis Report

## Summary
- **Total lines analyzed:** 9988
- **Time range:** 2026-08-10 10:00:00 to 2026-08-10 10:15:27
- **Distinct trace IDs:** 1919

## Log Levels Distribution
- **INFO:** 8502
- **WARN:** 425
- **ERROR:** 1039

## Error Statistics
- **Total Errors:** 1039
- **Error Rates by Module:**
  - Gateway: 32.27% (436/1351)
  - UserService: 13.01% (127/976)
  - OrderService: 12.09% (123/1017)
  - PaymentService: 11.37% (108/950)
  - InventoryService: 7.76% (102/1314)
  - Database: 3.53% (86/2439)
  - Cache: 3.08% (47/1524)
  - Notification: 2.64% (10/379)

## Slow Requests Statistics
- **Total Requests:** 2117
- **Average response time:** 702 ms
- **P95 response time:** 3048 ms
- **Total slow requests (over 1000 ms):** 482 (22.77%)

### Top 10 Slow Requests
1. **Trace ID:** t00142, **Module:** Gateway, **Time:** 2026-08-10 10:01:12.601, **Response Time:** 3345 ms, **Status:** ERROR
2. **Trace ID:** t00460, **Module:** Gateway, **Time:** 2026-08-10 10:03:35.904, **Response Time:** 3341 ms, **Status:** ERROR
3. **Trace ID:** t01838, **Module:** Gateway, **Time:** 2026-08-10 10:14:40.580, **Response Time:** 3341 ms, **Status:** ERROR
4. **Trace ID:** t00916, **Module:** Gateway, **Time:** 2026-08-10 10:07:14.296, **Response Time:** 3335 ms, **Status:** ERROR
5. **Trace ID:** t01596, **Module:** Gateway, **Time:** 2026-08-10 10:12:42.224, **Response Time:** 3335 ms, **Status:** ERROR
6. **Trace ID:** t00593, **Module:** Gateway, **Time:** 2026-08-10 10:04:40.049, **Response Time:** 3321 ms, **Status:** ERROR
7. **Trace ID:** t00597, **Module:** Gateway, **Time:** 2026-08-10 10:04:42.146, **Response Time:** 3295 ms, **Status:** ERROR
8. **Trace ID:** t00508, **Module:** Gateway, **Time:** 2026-08-10 10:04:03.224, **Response Time:** 3293 ms, **Status:** ERROR
9. **Trace ID:** t01886, **Module:** Gateway, **Time:** 2026-08-10 10:15:07.900, **Response Time:** 3293 ms, **Status:** ERROR
10. **Trace ID:** t00127, **Module:** Gateway, **Time:** 2026-08-10 10:01:04.029, **Response Time:** 3286 ms, **Status:** ERROR

## Parse Quality
- **Parsed correctly:** 9930 lines
- **Partial parses:** 36 lines
- **Malformed lines:** 22 lines
- **Missing fields:**
  - timestamp: 37
  - level: 22
  - module: 38
  - traceId: 27

## Recommendations
- Investigate high error rates in the Gateway module, especially related to the 504 status errors.
- Optimize requests to the Gateway to reduce average response time to avoid exceeding the 1000 ms threshold.