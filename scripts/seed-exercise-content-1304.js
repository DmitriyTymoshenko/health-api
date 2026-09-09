#!/usr/bin/env node
/**
 * scripts/seed-exercise-content-1304.js — one-off content seeding for the 17 exercises
 * of training program #1290 in `exercises_library` (task #1304).
 *
 * WHY a script, not 17 manual curls: every one of these 17 names is Cyrillic with
 * spaces. Lesson #1286 (reconfirmed #1290): the client must call `encodeURIComponent()`
 * EXACTLY ONCE — Express decodes `req.params` exactly once, so a double-encode or a
 * hand-typed `--data-urlencode` slip silently 404s or (worse) matches a DIFFERENT
 * document. This script centralizes that single encode call so it can't be gotten
 * wrong per-exercise.
 *
 * WHY it hits the HTTP route, not Mongo directly: `PATCH /api/workouts/exercises/:name`
 * (routes/workouts.js, task #1304) is a whitelist $set — {description_ua, video_url,
 * image_url, cues} only, exact-name findOne, 404 on no match, never writes
 * name/muscle_group/equipment/_id. Going through the route exercises that exact
 * production code path instead of duplicating (and risking drifting from) its logic.
 *
 * Content source: Lisa's live WebSearch pass, task #1304 comment (2026-09-09 18:09),
 * re-verified against `exercises_library.name` byte-for-byte via
 * `curl localhost:3001/api/workouts/exercises`. 12/17 have a video_url; the other 5
 * (Тяга верхнього блоку, Планка, Жим гантелей стоячи, Пуловер, Віджимання на брусах)
 * intentionally have an EMPTY video_url — no video was found, and Apex's triage
 * (task #1304, comment 18:17) forbids padding with a hastily-picked substitute.
 * `image_url` is intentionally left OUT of every entry — MuscleWiki ToS forbids
 * re-hosting/embedding their photos outside their own app (Lisa's 18:09 comment),
 * so photo generation is a separate, non-blocking follow-up ticket.
 *
 * Idempotent: PATCH with the same content twice is a no-op $set, safe to re-run.
 *
 * Usage:
 *   node scripts/seed-exercise-content-1304.js [baseUrl]
 *   # baseUrl defaults to http://localhost:3001 — pass a different port for a
 *   # disposable pre-restart smoke instance, e.g.:
 *   node scripts/seed-exercise-content-1304.js http://localhost:3099
 */

const BASE_URL = process.argv[2] || 'http://localhost:3001'

// name — byte-for-byte from `exercises_library.name` (verified against live GET /exercises).
const CONTENT = [
  {
    name: 'Жим гантелей лежачи',
    description_ua: "Лягти на горизонтальну лаву, гантелі тримати над грудьми прямим хватом, лопатки зведені й прижаті до лави, ступні на підлозі. Опускати гантелі до рівня грудей, розводячи локті ~45° (не в сторони на 90°), у нижній точці плечі паралельно підлозі або нижче. Виштовхнути гантелі вгору без клацання ліктів у верхній точці.",
    video_url: 'https://www.youtube.com/shorts/xC4-GT2hEhk',
  },
  {
    name: 'Тяга гантелі',
    description_ua: 'Одне коліно й одна рука на лаву, спина пряма, корпус майже паралельний підлозі. Тягнути гантель ліктем назад-вгору до стегна, лікоть тримати близько до тіла, лопатку зводити в кінці руху. Опускати підконтрольно, без ривка спиною.',
    video_url: 'https://www.youtube.com/watch?v=gfUg6qWohTk',
  },
  {
    name: 'Жим ногами',
    description_ua: 'Ступні на платформі трохи ширше плечей, спина й лопатки щільно в спинці сидіння. Опускати платформу, згинаючи коліна до кута ~90° (коліна не заходять за носки, не притискаються до грудей повністю), розгинати ноги без повного «замка» колін у верхній точці.',
    video_url: 'https://www.youtube.com/shorts/nDh_BlnLCGc',
  },
  {
    name: 'Тяга верхнього блоку',
    description_ua: 'Сидячи, стегна зафіксовані валиком, хват трохи ширше плечей, корпус відхилений назад ~10-20°. На видиху тягнути рукоять до верхньої частини грудей, ведучи локтями вниз-назад і зводячи лопатки; рухається тільки рука, корпус нерухомий. Повертати вагу підконтрольно до повного випрямлення рук.',
    video_url: '',
  },
  {
    name: 'Розгинання ніг',
    description_ua: 'Сидячи, валик на нижній частині гомілки, спина щільно в спинці, руки тримають бокові рукояті. На видиху розігнути ноги, у верхній точці коліна НЕ заводити в повний замок (щоб не травмувати суглоб), на вдиху підконтрольно опустити.',
    video_url: 'https://www.youtube.com/watch?v=LecjJyaIP6A',
  },
  {
    name: 'Згинання ніг',
    description_ua: "Лежачи на животі, валик на нижній частині гомілки якраз під ахіллом, таз щільно прижатий до лави (не піднімати). Згинати ноги до максимуму без відриву стегон від лави, у нижній точці не давати вазі різко «падати».",
    video_url: 'https://www.youtube.com/watch?v=K6drcQwYmO4',
  },
  {
    name: 'Підйом на носки',
    description_ua: "Передня частина стопи на платформі, п'яти вільно звисають. Опускати п'яти нижче рівня платформи (повна розтяжка литки), потім піднятися максимально вгору на носки, затримка на секунду у верхній точці, рух повільний і контрольований без різких ривків.",
    video_url: 'https://www.youtube.com/watch?v=4HQ8Am9IuME',
  },
  {
    name: 'Планка',
    description_ua: 'Упор на передпліччя (лікті під плечима) і носки, тіло — пряма лінія від плечей до п\'ят, без прогину в поясниці й без піднятого таза. Живіт і сідниці напружені, шия нейтральна (дивитись вниз), дихання спокійне, без затримки.',
    video_url: '',
  },
  {
    name: 'Жим гантелей стоячи',
    description_ua: 'Стоячи, гантелі на рівні плечей нейтральним хватом (долоні одна до одної), легкий згин у колінах, корпус/кор напружені. Виштовхнути гантелі над головою без прогину в поясниці, у верхній точці руки майже прямі; нейтральний хват знижує навантаження на плечові/ліктьові суглоби порівняно з прямим хватом.',
    video_url: '',
  },
  {
    name: 'Пуловер',
    description_ua: 'Лежачи поперек лави (тільки лопатки на лаві, стегна й ступні на підлозі), гантель тримати прямим хватом над грудьми, невеликий згин у ліктях фіксований протягом усього руху. На вдиху опускати гантель дугою за голову до відчуття розтяжки грудей/широких, на видиху повертати назад над груди.',
    video_url: '',
  },
  {
    name: 'Розведення в сторони',
    description_ua: 'Стоячи, гантелі внизу вздовж тіла, легкий згин у ліктях фіксований. Піднімати руки в сторони до рівня плечей (не вище), лідирувати ліктем, не гойдати корпус і не використовувати інерцію.',
    video_url: 'https://www.youtube.com/watch?v=bL5PalwY60M',
  },
  {
    name: 'Розведення на задню дельту',
    description_ua: 'Нахил корпусу вперед до ~90° (або лежачи грудьми на нахиленій лаві), руки звисають, легкий згин у ліктях. Розводити руки в сторони-назад, зводячи лопатки, хват пронований (долоні назад) для кращої ізоляції задньої дельти; лопатки розведені (не зводити занадто рано, щоб не забирали навантаження трапеції).',
    video_url: 'https://www.youtube.com/watch?v=lPt0GqwaqEw',
  },
  {
    name: 'Молоткові згинання на лаві Скотта',
    description_ua: 'Плече лежить на пюпітрі лави Скотта, хват молотковий (долоні одна до одної, нейтрально). Згинати руку до максимуму без відриву плеча від пюпітра, вгорі — пікове скорочення, опускати підконтрольно до майже повного розгинання. Лава виключає читинг корпусом.',
    video_url: 'https://www.youtube.com/watch?v=9kMkjOPA7qs',
  },
  {
    name: 'Канат на трицепс',
    description_ua: 'Стоячи біля блоку, хват канату нейтральний, лікті прижаті до корпусу й нерухомі протягом усього руху. Розгинати руки вниз, у нижній точці розвести кінці канату в сторони для пікового скорочення трицепса, повертати підконтрольно без розгойдування ліктів.',
    video_url: 'https://www.youtube.com/watch?v=vPeQu_L-1n0',
  },
  {
    name: 'Підтягування',
    description_ua: "Хват нейтральний (долоні одна до одної, паралельні рукояті/турнік типу «мультигрип»), руки майже прямі на старті. Тягнутись підборіддям вище рук, зводячи лопатки вниз-назад, без розгойдування тіла (кіпінгу). Опускатись підконтрольно до майже повного випрямлення рук.",
    video_url: 'https://www.youtube.com/shorts/iW09BYD0tPA',
  },
  {
    name: 'Віджимання на брусах',
    description_ua: 'Хват брусів нейтральний (долоні одна до одної), руки прямі, корпус трохи нахилений вперед, лопатки зведені й опущені. Опускатись згинаючи лікті (тримати їх близько до тіла) до кута плеча ~90° або нижче, підійматись до повного випрямлення рук без різкого «замка».',
    video_url: '',
  },
  {
    name: 'Підйом ніг',
    description_ua: 'Вис на турніку прямим або нейтральним хватом, без розгойдування. Піднімати прямі (або злегка згнуті) ноги вгору, підкручуючи таз на видиху (як у скручуванні, а не просто згин у тазі), опускати повільно, зберігаючи напругу преса весь час.',
    video_url: 'https://www.youtube.com/watch?v=JXztA3fLp50',
  },
]

async function main() {
  console.log(`Seeding ${CONTENT.length} exercises against ${BASE_URL} ...`)
  let ok = 0
  let fail = 0
  for (const item of CONTENT) {
    // Exactly ONE encodeURIComponent call — lesson #1286/#1290.
    const url = `${BASE_URL}/api/workouts/exercises/${encodeURIComponent(item.name)}`
    const body = { description_ua: item.description_ua, video_url: item.video_url }
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (res.status === 200) {
        ok++
        console.log(`OK   ${item.name} -> video_url=${item.video_url ? 'set' : '(empty)'}`)
      } else {
        fail++
        console.error(`FAIL ${item.name} -> HTTP ${res.status} ${JSON.stringify(json)}`)
      }
    } catch (err) {
      fail++
      console.error(`FAIL ${item.name} -> ${err.message}`)
    }
  }
  console.log(`Done: ${ok} ok, ${fail} failed (of ${CONTENT.length})`)
  if (fail > 0) process.exit(1)
}

main()
