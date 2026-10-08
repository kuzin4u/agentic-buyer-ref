# Карта документов

| Документ | Для чего читать |
|---|---|
| [`../../CLAUDE.md`](../../CLAUDE.md) | Правила работы, инварианты агента, стек, структура кода |
| [`SPEC.md`](SPEC.md) | ТЗ на агента: требования Т1–Т16, архитектура, поведение на отказы |
| [`CONTOUR.md`](CONTOUR.md) | ТЗ на эмулятор К1–К8 и порядок проверок шлюза |
| [`protocol/`](protocol/) | ПАО v1 — контракт с Платформой ПС (копия фиксированной версии) |
| [`openapi.yaml`](openapi.yaml) | Контракт лёгкого мока К1–К8 |
| [`NORMS.md`](NORMS.md) | Нормы A1–A9, на которые ссылается код |
| [`SCENARIOS.md`](SCENARIOS.md) | 30 сценариев приёмки (источник — `tests/scenarios/scenarios.json`) |
| [`PARAMS.md`](PARAMS.md) | Стендовые параметры и что должен измерить прогон |
| [`DECISIONS.md`](DECISIONS.md) | Журнал решений Р1–Р13 |
| [`ROADMAP.md`](ROADMAP.md) | План продукта по этапам и часам |
| [`STATUS.md`](STATUS.md) | Состояние, расхождения, план следующей сессии |
| [`GLOSSARY.md`](GLOSSARY.md) | Термины |
| [`../reference/agentic-commerce-vision-agent.html`](../reference/agentic-commerce-vision-agent.html) | Обзор поля, четыре разреза, конфликты, интерактивная модель сделки |
| [`../reference/pul/`](../reference/pul/) | Исходный пул (38 материалов). Начинать с `00-ukazatel-pula.html`; нормы — `21-drafty-dokumentov.html`; ТЗ — `22`; интерфейсы — `23`; конфликты — `29` |

Порядок чтения для новой сессии: CLAUDE.md → STATUS.md → нужный раздел SPEC/CONTOUR → NORMS по ссылке из требования.
