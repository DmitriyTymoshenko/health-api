
const { buildReadiness } = require('../../lib/readiness')
const { validateVerdict } = require('../../lib/koliada-validate')
const { postprocessOne } = require('../../lib/recs-postprocess')
const { formatSnippets } = require('../../lib/koliada-retrieve')
const quote = 'vitamin D absorption improves with fat'
const corpus = '## Lesson 12\n' + quote + '\n## Lesson 27\ncreatine is discussed here'
const verdict = {kind:'confirms',by:'koliada',ref:'Lesson 12',quote}
const absent = {kind:'not_covered',by:'external'}
describe('#1983 imported reliability regressions', () => {
  test.each([[[]], [[{name:'new'}]]])('zero evaluated never claims progress %j', (todayExercises) => {
    const r = buildReadiness({recoveryToday:{recovery_score:78},recoveryHistory:[],todayStr:'2026-10-04',todayExercises,exerciseTrends:{exercises:[]}})
    expect(r.level).toBe('as_planned')
    expect(r.reason_text).not.toContain('прогрес по вправах є')
    expect(r.reason_text).toContain(todayExercises.length ? 'історії по вправах ще недостатньо' : 'вправ на сьогодні немає')
  })
  test('right lesson matches; wrong lesson cannot borrow another quote', () => {
    expect(validateVerdict(verdict,corpus)).toEqual(verdict)
    expect(validateVerdict({...verdict,ref:'Lesson 27'},corpus)).toEqual(absent)
  })
  test.each(['confirms','neutral','against'])('external URL alone never grounds %s', (kind) => {
    expect(validateVerdict({kind,by:'external',ref:'https://examine.com/x',quote},corpus)).toEqual(absent)
  })
  test('punctuation-only quote is not evidence', () => {
    expect(validateVerdict({...verdict,quote:'...'},corpus)).toEqual(absent)
  })
  test('range metadata cannot prove individual lesson', () => {
    const text = 'title: Koliada (lessons 1-38)\n\n' + quote
    expect(validateVerdict(verdict,text)).toEqual(absent)
    expect(validateVerdict({...verdict,ref:'lessons 1–38'},text).kind).toBe('confirms')
  })
  test('snippet metadata binds quotes independently', () => {
    const text = formatSnippets([{ref:'Lesson 12',startLine:1,endLine:2,text:quote},{ref:'Lesson 27',startLine:3,endLine:4,text:'creatine is discussed here'}])
    expect(validateVerdict({...verdict,ref:'Lesson 27'},text)).toEqual(absent)
    expect(validateVerdict(verdict,text)).toEqual(verdict)
  })
  test('unverified external against must not turn into a positive candidate', () => {
    expect(postprocessOne({name:'new',verdict:{kind:'against',by:'external',ref:'https://examine.com/x'}},{activeStack:[],corpusText:corpus}).rec).toBeNull()
  })
  test('postprocessor exposes computed provenance and overrides LLM claims', () => {
    const raw = {name:'new',provenance:{state:'verified'},verdict:{kind:'confirms',by:'external',ref:'https://examine.com/x'},suggested:{dose:'unchanged'}}
    const {rec} = postprocessOne(raw,{activeStack:[],corpusText:corpus})
    expect(rec.verdict).toEqual(absent)
    expect(rec.provenance.state).toBe('unverified')
    expect(rec.suggested.dose).toBe('unchanged')
    expect(raw.provenance.state).toBe('verified')
  })
})
export {}

describe('#1983 source boundaries and compatibility', () => {
  const { validateVerdictWithProvenance } = require('../../lib/koliada-validate')
  test('external content must match exact URL and quote; LLM evidence ignored', () => {
    const v = {kind:'confirms',by:'external',ref:'https://examine.com/x',quote,evidence:{url:'https://examine.com/x',text:quote}}
    expect(validateVerdict(v,corpus)).toEqual(absent)
    expect(validateVerdict(v,corpus,[{url:'https://examine.com/other',text:quote}])).toEqual(absent)
    expect(validateVerdict(v,corpus,[{url:v.ref,text:'unrelated'}])).toEqual(absent)
    const out = validateVerdictWithProvenance(v,corpus,[{url:v.ref,text:quote}])
    expect(out.verdict).toEqual({kind:v.kind,by:v.by,ref:v.ref,quote})
    expect(out.provenance.state).toBe('quote_matched')
    expect(out.provenance.verified_at).toBeUndefined()
  })
  test('reject ambiguous refs, overlong and metadata-only quotes', () => {
    for (const ref of ['Lesson 12 or Lesson 27','Lesson 1','Lesson 120']) expect(validateVerdict({...verdict,ref},corpus)).toEqual(absent)
    expect(validateVerdict({...verdict,quote:'Lesson 12'},corpus)).toEqual(absent)
    expect(validateVerdict({...verdict,quote:'x'.repeat(301)},'## Lesson 12\n'+'x'.repeat(301))).toEqual(absent)
  })
  test('snippet context crossing another lesson fails closed', () => {
    const text = formatSnippets([{ref:'Lesson 27',startLine:1,endLine:4,text:corpus}])
    expect(validateVerdict({...verdict,ref:'Lesson 27'},text)).toEqual(absent)
  })
  test('unattributed text and ordinary lesson mentions do not establish source metadata', () => {
    expect(validateVerdict(verdict,quote)).toEqual(absent)
    expect(validateVerdict(verdict,'Someone mentions Lesson 12: '+quote)).toEqual(absent)
  })
  test('partial coverage names its limitation; physiologic boundaries unchanged', () => {
    for (const [score,level] of [[33,'base_only'],[34,'hold'],[66,'hold'],[67,'as_planned']]) {
      const r=buildReadiness({recoveryToday:{recovery_score:score},recoveryHistory:[],todayStr:'2026-10-04',todayExercises:[{name:'up'},{name:'new'}],exerciseTrends:{exercises:[{name:'up',status:'up'}]}})
      expect(r.level).toBe(level)
      expect(r.trend_coverage).toEqual({evaluated:1,insufficient:1})
      if (score===67) expect(r.reason_text).toContain('для решти історії ще недостатньо')
    }
  })
})

describe('#1983 retrieval source metadata', () => {
  const { retrieveKoliadaSnippets } = require('../../lib/koliada-retrieve')
  test('prose mentions cannot narrow the actual source range', () => {
    const text = '# Course (lessons 1-38)\nA mention of Lesson 12 in prose.\n'+quote
    const snippets = retrieveKoliadaSnippets(text,['vitamin D'],{contextLines:1})
    expect(snippets[0].ref).toBe('lessons 1-38')
    expect(validateVerdict(verdict,formatSnippets(snippets))).toEqual(absent)
  })
  test('retrieval clips context at lesson boundaries', () => {
    const snippets = retrieveKoliadaSnippets(corpus,['creatine'],{contextLines:3})
    expect(validateVerdict({...verdict,ref:'Lesson 27'},formatSnippets(snippets))).toEqual(absent)
  })
  test('actual vault source range can ground a quote without inventing a lesson', () => {
    const { loadCorpus } = require('../../lib/koliada-corpus')
    const text=loadCorpus().text
    const v={...verdict,ref:'lessons 1-38',quote:'Health: Definition and Influencing Factors'}
    expect(validateVerdict(v,text)).toEqual(v)
    expect(validateVerdict({...v,ref:'Lesson 12'},text)).toEqual(absent)
  })
})
