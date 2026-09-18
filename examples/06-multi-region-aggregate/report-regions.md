# 地区销售汇总

| 地区 | 文件 | 有效记录 | 销售额 |
|---|---|---|---|
| east | data/regions/east.txt | 3 | 3300.5 |
| north | data/regions/north.csv | 4 | 5050.5 |
| south | data/regions/south.csv | 4 | 6144.25 |
| **合计** | | 11 | **14495.25** |

## 处理说明

- 金额去除 ¥ 与千分位分隔符；`Refund` 行为负数计入
- 跳过无法解析的记录:
  - data/regions/east.txt: `Service Plan ... 待确认`
