import test from 'node:test';
import assert from 'node:assert/strict';
import { costPage } from './pages.mjs';
const user={id:'test-user',display_name:'<script>alert(1)</script>',email:'" autofocus onfocus="alert(1)'};
test('manual cost editors address each repository variant and preserve existing date-only values',()=>{
  const html=costPage(user,[{id:'store',connected:true}],{canEdit:true,rows:[
    {product_id:'product-1',id:'variant-1',wb_article:'123',unit_cost:'0',effective_from:new Date(2026,0,1)},
    {product_id:'product-1',id:'variant-2',wb_article:'123',unit_cost:null}
  ]});
  assert.equal((html.match(/action="\/costs\/save"/g)||[]).length,2);
  assert.match(html,/name="variantId" value="variant-1"/);
  assert.match(html,/name="variantId" value="variant-2"/);
  assert.match(html,/name="unitCost"[^>]*value="0"/);
  assert.match(html,/name="effectiveFrom" value="2026-01-01"/);
  assert.equal((html.match(/id="cost-product-product-1"/g)||[]).length,1);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  assert.ok(html.includes(`name="effectiveFrom" value="${today}"`));
});
test('failed manual edit retains escaped submitted values only for its own row',()=>{
  const html=costPage(user,[{id:'store',connected:true}],{rows:[
    {id:'variant-1',product_id:'product" onclick="bad',wb_article:'123',unit_cost:'10',effective_from:'2026-01-01'},
    {id:'variant-2',wb_article:'124',unit_cost:'20',effective_from:'2026-02-01'}
  ]},{manualError:'Ошибка <script>',manualValues:{variantId:'variant-1',unitCost:'" autofocus onfocus="bad',effectiveFrom:'2025-09-01'}});
  assert.equal((html.match(/class="cost-editor" open/g)||[]).length,1);
  assert.match(html,/value="&quot; autofocus onfocus=&quot;bad"/);
  assert.match(html,/name="effectiveFrom" value="2025-09-01"/);
  assert.match(html,/name="unitCost"[^>]*value="20"/);
  assert.match(html,/Ошибка &lt;script&gt;/);
  assert.match(html,/id="cost-product-product&quot; onclick=&quot;bad"/);
  assert.doesNotMatch(html,/value="" autofocus|id="cost-product-product" onclick|Ошибка <script>/);
});
test('viewers see coverage and amounts without manual or file write forms',()=>{
  const store={id:'store',connected:true},state={canEdit:false,rows:[{id:'variant',wb_article:'123',unit_cost:'25',effective_from:'2026-01-01'}]};
  for(const viewer of [user,{...user,role:'viewer'}]){
    const html=costPage(viewer,[store],state);
    assert.match(html,/25,00 ₽/);
    assert.match(html,/\/costs\/template.csv/);
    assert.doesNotMatch(html,/action="\/costs\/(save|import)"/);
  }
  assert.doesNotMatch(costPage({...user,role:'viewer'},[store],{rows:state.rows}),/action="\/costs\/(save|import)"/);
});
test('manual errors remain visible when the submitted variant is no longer in the list',()=>{
  const html=costPage(user,[{id:'store',connected:true}],{rows:[]},{manualError:'Вариант больше не доступен.',manualValues:{variantId:'removed',unitCost:'50',effectiveFrom:'2026-01-01'}});
  assert.match(html,/role="alert">Вариант больше не доступен\./);
});
test('historical product remains cost-capable without a stale WB link or photo',()=>{
  const html=costPage(user,[{id:'store',connected:true}],{rows:[{id:'historical-variant',wb_article:'800001',seller_article:'DELETED',historical_deleted:true,image_url:'https://basket-01.wbbasket.ru/old.webp',barcode:'80000101',unit_cost:null}]});
  assert.match(html,/Удалённый товар/);assert.match(html,/Баркод: 80000101/);assert.match(html,/Не указана/);
  assert.match(html,/name="variantId" value="historical-variant"/);
  assert.doesNotMatch(html,/wildberries\.ru\/catalog\/800001|old\.webp/);
});
test('cost page offers a table import, template and current coverage',()=>{const store={id:'11111111-2222-4333-8444-555555555555',name:'Мой WB',status:'active',connected:true};const costs={summary:{totalVariants:2,configuredVariants:1},rows:[{wb_article:'123456789',seller_article:'SKU-1',title:'Часы & ремешок',variant_id:'variant-1',external_variant_id:'size-42',size_label:'42',color_label:'Белый',barcode:'4600000000001',unit_cost:'1250.5',effective_from:'2026-09-01'},{wb_article:'123456790',seller_article:'SKU-2',title:'Другой товар',variant_id:'variant-2',external_variant_id:'size-44',size_label:'44',barcode:'4600000000002',unit_cost:null}],lastImport:{file_name:'costs.xlsx',created_at:'2026-09-17T08:30:00Z',applied_rows:1,skipped_rows:0,invalid_rows:1}};const html=costPage(user,[store],costs);assert.match(html,/action="\/costs\/import"/);assert.match(html,/enctype="multipart\/form-data"/);assert.match(html,/accept="\.csv,\.tsv,\.xlsx/);assert.match(html,/href="\/costs\/template\.csv\?storeId=11111111-2222-4333-8444-555555555555"/);assert.match(html,/50%/);assert.match(html,/1 из 2 вариантов/);assert.match(html,/1\s250,50 ₽/);assert.match(html,/Не указана/);assert.match(html,/Часы &amp; ремешок/);assert.match(html,/costs\.xlsx/);});
test('cost page renders PostgreSQL DATE values without a UTC shift or Invalid Date',()=>{const store={id:'store-1',name:'WB',connected:true};const costs={summary:{totalVariants:1,configuredVariants:1},rows:[{wb_article:'123',seller_article:'SKU-1',title:'Товар',variant_id:'variant-1',unit_cost:'407',effective_from:new Date(2026,0,1)}]};const html=costPage(user,[store],costs);assert.match(html,/с 01\.01\.2026/);assert.doesNotMatch(html,/Invalid Date/);});
test('cost page remains locked until Wildberries is connected',()=>{const html=costPage(user,[{id:'store-1',name:'Магазин',connected:false}],null);assert.match(html,/Сначала подключите Wildberries/);assert.doesNotMatch(html,/action="\/costs\/import"/);});
test('cost page renders row-level import errors',()=>{const store={id:'store-1',name:'Магазин',connected:true};const html=costPage(user,[store],{rows:[],summary:{totalVariants:0,configuredVariants:0}},{error:'Файл не применён.',importErrors:[{rowNumber:7,code:'cost_variant_not_found'}]});assert.match(html,/Строка 7: вариант не найден среди выбранных товаров/);});
