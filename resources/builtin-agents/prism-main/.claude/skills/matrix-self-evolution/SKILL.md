---
name: matrix-self-evolution
description: |
  Matrix 自我进化系统 - 集成 Karpathy Skills + GenericAgent + SCOPE 三大框架
  为 Matrix 多智能体系统提供行为规范、技能进化和提示词自我优化能力
version: 1.0.0
author: Meta (Matrix System)
integrated: 2026-04-20
---

# Matrix 自我进化系统

## 概述

本技能整合三大 AI Agent 自我进化框架：

1. **Karpathy Skills** - 行为规范 (Think/Simplicity/Surgical/Goal-Driven)
2. **GenericAgent** - 技能固化与三层记忆系统
3. **SCOPE** - 提示词自我进化 (Tactical/Strategic 双流记忆)

## 安装

### 依赖安装
```bash
pip install redis qdrant-client neo4j numpy matplotlib Pillow
```

### 基础设施启动
```bash
cd ~/.openclaw/workspace/matrix/infrastructure
docker-compose -f docker-compose.memory.yml up -d
```

## 模块结构

```
matrix/
├── tools/
│   └── task_planner.py          # Karpathy 任务规划器
├── config/
│   └── review-checklist.yaml    # 代码审查清单
├── memory/
│   ├── l1_working.py            # L1 工作记忆 (Redis)
│   ├── l2_short_term.py         # L2 短期记忆 (SQLite)
│   ├── l3_long_term.py          # L3 长期记忆 (Qdrant+Neo4j)
│   └── unified_memory.py        # 统一记忆接口
├── evolution/
│   ├── skill_crystallizer.py    # 技能固化引擎
│   └── test_crystallizer.py     # 测试用例
└── scope/
    ├── dual_memory.py           # 双流记忆系统
    ├── trigger_detector.py      # 触发检测器
    ├── guideline_synthesizer.py # 指南合成器
    ├── scope_engine.py          # SCOPE 主引擎
    └── __init__.py              # 统一导出
```

## 使用方法

### 1. 任务规划 (Karpathy Skills)

```python
from matrix.tools.task_planner import plan_task

plan = plan_task("创建一个用户认证系统")
print(plan.to_markdown())
```

### 2. 技能固化 (GenericAgent)

```python
from matrix.memory.unified_memory import UnifiedMemory
from matrix.evolution.skill_crystallizer import SkillCrystallizer

memory = UnifiedMemory()
crystallizer = SkillCrystallizer(memory)

# 记录执行轨迹
skill = crystallizer.crystallize(trace)

# 应用技能
result = crystallizer.apply_skill(skill, params)
```

### 3. 提示词优化 (SCOPE)

```python
from matrix.scope import SCOPEEngine, ExecutionTrace

engine = SCOPEEngine()

# 记录执行
triggered, trigger = engine.record_execution(trace)

# 优化提示词
if triggered:
    result = engine.optimize_prompt(current_prompt)
    new_prompt = result.optimized_prompt
```

## 测试

```bash
cd ~/.openclaw/workspace/matrix/tests

# 测试记忆系统
python3 test_memory_system.py

# 测试 SCOPE 系统
python3 test_scope_system.py
```

## 配置

### 环境变量
```bash
export REDIS_HOST=localhost
export REDIS_PORT=6379
export QDRANT_HOST=localhost
export QDRANT_PORT=6333
export NEO4J_URI=bolt://localhost:7687
export NEO4J_USER=neo4j
export NEO4J_PASSWORD=matrix123
```

### Python 路径
```python
import sys
sys.path.insert(0, '~/.openclaw/workspace')
```

## 健康检查

```python
from matrix.memory.unified_memory import UnifiedMemory

memory = UnifiedMemory()
health = memory.health_check()
print(health)
```

## 故障排除

**Redis 连接失败**
→ 检查 Redis 是否运行: `docker ps | grep redis`

**Qdrant/Neo4j 连接失败**
→ 系统会自动切换到离线模式，使用内存缓存

**导入错误**
→ 确保 Python 路径包含 `~/.openclaw/workspace`

## 参考文档

- Phase 1 研究: `matrix/knowledge/research/01_andrej_karpathy_skills_analysis.md`
- Phase 2 研究: `matrix/knowledge/research/02_generic_agent_analysis.md`
- Phase 3 研究: `matrix/knowledge/research/03_scope_analysis.md`
- 集成建议: `matrix/knowledge/research/05_matrix_integration_recommendations.md`

## 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0.0 | 2026-04-20 | 初始版本，整合三大框架 |
