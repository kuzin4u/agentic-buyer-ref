# Карта документов

| Документ | Для чего читать |
|---|---|
| [`../../CLAUDE.md`](../../CLAUDE.md) | Правила работы, инварианты агента, стек, структура кода |
| [`SPEC.md`](SPEC.md) | ТЗ на агента: требования Т1–Т16, архитектура, поведение на отказы |
| [`CONTOUR.md`](CONTOUR.md) | Компоненты К1–К8 пула и чем закрыт каждый (ПАО, `PaoStub`, стенд и эмулятор продавцов Платформы — Р26); витрины; порядок проверок шлюза |
| [`protocol/`](protocol/) | ПАО v1 — контракт с Платформой ПС (копия версии 1.4.0; источник и порядок перехода — `protocol/SOURCE.md`, Р20, Р31, Р33) |
| [`openapi.yaml`](openapi.yaml) | Справочник терминов пула (К1–К8), заморожен — не контракт (Р26) |
| [`NORMS.md`](NORMS.md) | Нормы A1–A9, на которые ссылается код |
| [`SCENARIOS.md`](SCENARIOS.md) | 30 сценариев приёмки (источник — `tests/scenarios/scenarios.json`) |
| [`PARAMS.md`](PARAMS.md) | Стендовые параметры и что должен измерить прогон |
| [`DECISIONS.md`](DECISIONS.md) | Журнал решений Р1–Р26 |
| [`ROADMAP.md`](ROADMAP.md) | План продукта по этапам и часам |
| [`STATUS.md`](STATUS.md) | Состояние, расхождения, план следующей сессии |
| [`GLOSSARY.md`](GLOSSARY.md) | Термины |
| [`../reference/agentic-commerce-vision-agent.html`](../reference/agentic-commerce-vision-agent.html) | Обзор поля, четыре разреза, конфликты, интерактивная модель сделки |
| [`../reference/joint-plan.md`](../reference/joint-plan.md) | План «Россия» ред. 1 (заменяет совместный план ред. 6–8): общее ядро, коды задач AG/PS/CO/UI, общий календарь, точки сверки С0–С6 |
| [`../reference/plan-west.md`](../reference/plan-west.md) | План «Запад» ред. 1: агент под брендом банка для ЕС и США — задачи AG-К, CO-К, UI-К, веха З1 |
| [`../reference/pul/`](../reference/pul/) | Исходный пул (38 материалов). Начинать с `00-ukazatel-pula.html`; нормы — `21-drafty-dokumentov.html`; ТЗ — `22`; интерфейсы — `23`; конфликты — `29` |

Порядок чтения для новой сессии: CLAUDE.md → STATUS.md → нужный раздел SPEC/CONTOUR → NORMS по ссылке из требования.
