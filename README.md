# Health API

REST API для Health Dashboard Дмитра. Express + MongoDB. Трекінг нутриції, добавок, лаб-аналізів, метрик WHOOP, тренувань, ваги, води, кроків.

## Швидкий старт

```bash
cd /root/chuttyevo-agent/health-api
node server.js          # Запуск API на порту 3001
npm test                # Запуск тестів (57 тестів)
npm run test:watch      # Watch-режим
```

**Перевірка:**
```bash
curl http://localhost:3001/health    # {"status":"ok"}
curl http://localhost:3001/api/version
```

## Стек

| Компонент | Технологія |
|-----------|------------|
| Runtime | Node.js 22, CommonJS |
| Framework | Express 4 |
| Database | MongoDB 6 (raw driver, без Mongoose) |
| TypeScript | Тільки в `src/` (types + middleware + tests) |
| Testing | Jest + ts-jest |
| PDF parsing | pdf-parse |
| File upload | multer |

## Структура

```
server.js               # Entry point — підключення MongoDB + монтування роутів
routes/                 # 17 JS-файлів роутів (CommonJS)
  nutrition.js          # Журнал харчування (CRUD)
  weight.js             # Журнал ваги + аналіз тренду
  water.js              # Споживання води + динамічна ціль від WHOOP
  steps.js              # Кроки (синк з iPhone)
  supplements.js        # Legacy-журнал добавок
  supplement_catalog.js # Каталог + цикли + трекінг прийому + база знань
  labs.js               # Лаб-аналізи + PDF-завантаження
  metrics.js            # Денні метрики WHOOP (recovery/HRV/sleep/strain)
  whoop.js              # Синк WHOOP
  workouts.js           # Тренування + особисті рекорди
  goals.js              # Цілі + розрахунок стриків
  foods.js              # База продуктів
  notes.js              # Нотатки
  settings.js           # Налаштування користувача
  activity.js           # Плани активності
  activity_plan.js      # CRUD планів активності
  body_measurements.js  # Виміри тіла
src/
  types/index.ts        # TypeScript-інтерфейси для всіх документів БД
  middleware/validate.ts # normalizeNutrition, requireFields, validateDate, normalizeSupplementId
  tests/                # Jest-тести
    validate.test.ts    # 17 тестів — middleware
    nutrition.test.ts   # 6 тестів — нормалізація нутриції
    supplement_catalog.test.ts # 6 тестів — логіка каталогу + цикли
    version.test.ts     # 3 тести — version endpoint
    water-notify.test.ts # 18 тестів — розрахунок цілі по воді
    personal-records.test.ts # 12 тестів — 1RM та PR-детекція
    weight.test.ts      # 14 тестів — аналіз тренду ваги + плато
    streak.test.ts      # 8 тестів — підрахунок стриків
    steps.test.ts       # 5 тестів — валідація кроків
```

## Колекції MongoDB

| Колекція | Опис |
|----------|------|
| `nutrition_log` | Записи харчування |
| `weight_log` | Виміри ваги |
| `water_log` | Споживання води |
| `steps_log` | Щоденні кроки |
| `supplements_log` | Legacy-журнал добавок |
| `supplement_catalog` | Каталог добавок |
| `supplement_cycles` | Цикли прийому (8 тижнів / 4 тижні перерва) |
| `supplement_intake` | Щоденний трекінг прийому |
| `supplement_knowledge` | Повний склад добавок |
| `lab_results` | Результати аналізів |
| `daily_metrics` | Метрики WHOOP (recovery/HRV/sleep/strain) |
| `whoop_cycles` | Дані циклів WHOOP |
| `workouts` | Тренувальні сесії + сети |
| `goals` | Цілі здоров'я |
| `user_settings` | Профіль та налаштування |
| `notes` | Нотатки з тегами |
| `activity_plans` | Плани активності |
| `body_measurements` | Виміри тіла |

## API Endpoints

### Основні

| Метод | Шлях | Опис |
|-------|------|------|
| GET | `/health` | Health check |
| GET | `/api/version` | Версія API |

### Нутриція

| Метод | Шлях | Опис |
|-------|------|------|
| GET | `/api/nutrition?date=YYYY-MM-DD` | Записи за день |
| POST | `/api/nutrition` | Додати прийом їжі |
| PUT | `/api/nutrition/:id` | Оновити запис |
| DELETE | `/api/nutrition/:id` | Видалити запис |
| GET | `/api/foods?q=назва` | Пошук у базі продуктів |

### Вага

| Метод | Шлях | Опис |
|-------|------|------|
| GET | `/api/weight` | Останні 50 записів |
| GET | `/api/weight/history?days=30` | Записи за N днів |
| GET | `/api/weight/analysis` | Аналіз тренду (плато / на плані / відстає / зависокий темп) |
| POST | `/api/weight` | Додати вимір |
| PUT | `/api/weight/:id` | Оновити |
| DELETE | `/api/weight/:id` | Видалити |

### Вода

| Метод | Шлях | Опис |
|-------|------|------|
| GET | `/api/water?date=YYYY-MM-DD` | Записи за день |
| GET | `/api/water/today` | Сьогодні + динамічна ціль від WHOOP |
| POST | `/api/water` | Логувати воду + тригер нотифікації |
| PUT | `/api/water/:id` | Оновити |
| DELETE | `/api/water/:id` | Видалити |

### Кроки

| Метод | Шлях | Опис |
|-------|------|------|
| GET | `/api/steps?date=YYYY-MM-DD` | Записи (останні 60) |
| POST | `/api/steps` | Синк з iPhone (body: `{date, steps, source?}`) |
| PUT | `/api/steps/:id` | Оновити |
| DELETE | `/api/steps/:id` | Видалити |

### Добавки

| Метод | Шлях | Опис |
|-------|------|------|
| GET | `/api/catalog` | Каталог добавок |
| POST | `/api/catalog` | Додати добавку |
| GET | `/api/catalog/intake?date=YYYY-MM-DD` | Трекер прийому за день |
| POST | `/api/catalog/intake` | Відмітити прийом |
| GET | `/api/catalog/cycles` | Активні цикли |
| GET | `/api/catalog/knowledge` | База складу добавок |

### Лаборатія

| Метод | Шлях | Опис |
|-------|------|------|
| GET | `/api/labs/latest` | Останні значення по кожному біомаркеру |
| GET | `/api/labs/reference` | Референсні діапазони |
| POST | `/api/labs/upload` | Завантажити PDF з аналізами |

### WHOOP / Метрики

| Метод | Шлях | Опис |
|-------|------|------|
| GET | `/api/metrics?date=YYYY-MM-DD` | Денні метрики |
| GET | `/api/whoop/cycles` | Цикли WHOOP |
| POST | `/api/whoop/sync` | Примусовий синк |

### Цілі та стрики

| Метод | Шлях | Опис |
|-------|------|------|
| GET | `/api/goals` | Всі цілі |
| POST | `/api/goals` | Створити ціль |
| GET | `/api/goals/streaks` | Розрахунок стриків за 90 днів |

### Тренування

| Метод | Шлях | Опис |
|-------|------|------|
| GET | `/api/workouts?date=YYYY-MM-DD` | Тренування за день |
| POST | `/api/workouts` | Логувати тренування |
| GET | `/api/workouts/personal-records/:exercise` | ОП та рекорди за вправою |

## Критичні правила

### supplement_id — завжди Number

```js
// ✅ Правильно
{ supplement_id: 3, date: '2026-03-31' }

// ❌ Неправильно — зламає пошук intake
{ supplement_id: '3', date: '2026-03-31' }
```

Використовуй middleware `normalizeSupplementId` на всіх intake-ендпоінтах.

### Поля нутриції — підтримка двох форматів

Приймаємо і `protein`, і `protein_g`. Middleware `normalizeNutrition` конвертує:
- `protein` → `protein_g`
- `fat` → `fat_g`  
- `carbs` → `carbs_g`
- `name` → `food_name`
- відсутня `date` → сьогодні (Kyiv timezone)

### Додавання нових роутів

1. Створи `routes/my-route.js` (CommonJS, `module.exports = function(getDB) { ... }`)
2. Підключи в `server.js`: `app.use('/api/my-route', require('./routes/my-route')(getDB))`
3. Напиши тест у `src/tests/my-route.test.ts`
4. Запусти `npm test`

## Deployment

```bash
npm run deploy
# Виконує: npm test → git commit/push → systemctl restart health-api
```

Systemd-сервіс: `health-api` (порт 3001)

Caddy proxy: `https://domain.com/health-api/*` → `localhost:3001`

## TypeScript

TypeScript тільки в `src/` — для типів, middleware та тестів. Роут-файли (`routes/*.js`) залишаються CommonJS.

Middleware пишиться в `src/middleware/`, тести — в `src/tests/`.

## Тестування

```bash
npm test
# 57 тестів, 9 test suites
```

Тести мають бути зеленими перед будь-яким мержем в `main`. При зміні middleware або бізнес-логіки — оновлюй відповідний test-файл.
