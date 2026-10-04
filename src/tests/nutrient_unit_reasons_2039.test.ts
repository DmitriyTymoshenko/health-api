const {sumStack,normalizeNutrientKey}=require('../../lib/nutrient-sum')
function aggregate(key:string,units:any[]){
 return sumStack([{id:1,name:'Fixture',servings_per_day:1}],new Map([[1,{active_ingredients:units.map(unit=>({name:key,nutrient_key:key,amount_per_dose:1,unit}))}]]))[0]
}
const unitReasons=(r:any)=>r.comparison.reasons.filter((x:string)=>['reference_unit_unknown','intake_unit_unknown','unit_mismatch','unit_conflict'].includes(x)).sort()
describe('#2039 precise unit reasons without conversion',()=>{
 it.each(['creatine','fish_oil'])('%s has unknown reference unit, not known-unit mismatch',key=>{
  const r=aggregate(key,['mg']);expect(r.comparison.status).toBe('not_comparable');
  expect(unitReasons(r)).toEqual(['reference_unit_unknown']);expect(r.unit).toBe('mg');expect(r.reference.unit).toBeNull()
 })
 it('known reference with missing intake unit reports only intake_unit_unknown',()=>{
  const r=aggregate('zinc',[null]);expect(r.comparison.status).toBe('not_comparable');
  expect(unitReasons(r)).toEqual(['intake_unit_unknown']);expect(r.total).toBe(1);expect(r.ul).toBe(40)
 })
 it('both absent units keep both unknown causes distinct',()=>{
  const r=aggregate('creatine',[null]);expect(r.comparison.status).toBe('not_comparable');
  expect(unitReasons(r)).toEqual(['intake_unit_unknown','reference_unit_unknown'])
 })
 it('two known different units report mismatch without converting the recorded amount',()=>{
  const r=aggregate('vitamin_d',['mg']);expect(r.comparison.status).toBe('not_comparable');
  expect(unitReasons(r)).toEqual(['unit_mismatch']);expect(r.total).toBe(1);expect(r.unit).toBe('mg');expect(r.reference.unit).toBe('IU')
 })
 it.each([['IU','mcg'],['mcg','IU'],[null,'IU']])('conflicting sources %s/%s do not mislabel the nulled output unit as missing intake',(a,b)=>{
  const r=aggregate('vitamin_d',[a,b]);expect(r.comparison.status).toBe('not_comparable');
  expect(unitReasons(r)).toEqual(['unit_conflict']);expect(r.unit_conflict).toBe(true);expect(r.total).toBeNull();expect(r.unit).toBeNull()
 })
 it('matching known units retain numeric comparison and zero unit reasons',()=>{
  const r=aggregate('zinc',['mg']);expect(r.comparison.status).toBe('not_above');expect(unitReasons(r)).toEqual([]);expect(r.total).toBe(1)
 })
 it('fish_oil remains unmapped to EPA+DHA',()=>{
  expect(normalizeNutrientKey('Fish oil')).toBe('fish_oil');expect(aggregate('fish_oil',['mg']).ul).toBeNull()
 })
})
export {}
