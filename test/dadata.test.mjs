// DaData: company, address and bank lookups against the suggestions and cleaner APIs (fetch is mocked, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialsFor } from '../src/hosted/credentials.mjs';
import { SERVICES } from '../src/index.mjs';
import { callJson, connect, installFetchMock, textOf } from './helpers.mjs';

const { calls, route } = installFetchMock();
const ENV = { DADATA_API_KEY: 'key-1' };
const SUGGEST = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs';
const CLEAN = 'https://cleaner.dadata.ru/api/v1';
const bodyOf = (call) => JSON.parse(call.init.body);
const sentSince = (n) => calls.slice(n);

const PARTY = {
  value: 'ООО "МОТОРИКА"',
  data: {
    inn: '7719402047', kpp: '772301001', ogrn: '1157746078984', ogrn_date: 1423094400000, type: 'LEGAL',
    branch_type: 'MAIN', branch_count: 0,
    name: { full_with_opf: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "МОТОРИКА"', short_with_opf: 'ООО "МОТОРИКА"' },
    state: { status: 'ACTIVE', registration_date: 1423094400000, liquidation_date: null },
    management: { name: 'Давидюк Андрей Павлович', post: 'ГЕНЕРАЛЬНЫЙ ДИРЕКТОР' },
    address: { value: 'г Москва, Волгоградский пр-кт, д 42 к 5, помещ 1Н' },
    okved: '72.19', employee_count: 369,
    finance: { tax_system: null, income: 4529961000, revenue: 4173859000, expense: 2943138000, year: 2025 },
    phones: [{ value: '+7 911 2410309' }], emails: [{ value: 'DAP@MOTORICA.ORG' }], invalid: null,
  },
};

test('dadata_party: findById/party with the Token header; fields are mapped, dates become YYYY-MM-DD', async () => {
  route(/findById\/party$/, { suggestions: [PARTY] });
  const c = await connect('dadata', ENV);
  const n = calls.length;
  const out = await callJson(c, 'dadata_party', { query: '7719402047' });
  const [call] = sentSince(n);
  assert.equal(call.url, `${SUGGEST}/findById/party`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Token key-1');
  assert.deepEqual(bodyOf(call), { query: '7719402047', count: 5 });
  assert.deepEqual(out.companies, [{
    name: 'ООО "МОТОРИКА"', fullName: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "МОТОРИКА"',
    inn: '7719402047', kpp: '772301001', ogrn: '1157746078984', ogrnDate: '2015-02-05', type: 'LEGAL',
    status: 'ACTIVE', registered: '2015-02-05', address: 'г Москва, Волгоградский пр-кт, д 42 к 5, помещ 1Н',
    director: { name: 'Давидюк Андрей Павлович', post: 'ГЕНЕРАЛЬНЫЙ ДИРЕКТОР' }, okved: '72.19', branchType: 'MAIN', employees: 369,
    finance: { year: 2025, revenue: 4173859000, income: 4529961000, expense: 2943138000 },
    phones: ['+7 911 2410309'], emails: ['DAP@MOTORICA.ORG'],
  }]);
});

test('dadata_party: a branch by KPP, a sole proprietor, a liquidated company; limit goes to count', async () => {
  const sole = {
    value: 'ИП Иванов Иван Иванович',
    data: {
      inn: '784806113663', ogrn: '316784700123456', type: 'INDIVIDUAL', branch_type: null, management: null, finance: null, phones: null,
      name: { short_with_opf: 'ИП Иванов Иван Иванович', full_with_opf: 'Индивидуальный предприниматель Иванов Иван Иванович' },
      state: { status: 'LIQUIDATED', registration_date: 1423094400000, liquidation_date: 1560000000000 }, address: { value: 'г Санкт-Петербург' },
    },
  };
  route(/findById\/party$/, { suggestions: [sole] });
  const c = await connect('dadata', ENV);
  const n = calls.length;
  const out = await callJson(c, 'dadata_party', { query: '784806113663', kpp: '540602001', limit: 2 });
  assert.deepEqual(bodyOf(sentSince(n)[0]), { query: '784806113663', count: 2, kpp: '540602001' });
  assert.equal(out.companies[0].type, 'INDIVIDUAL');
  assert.equal(out.companies[0].status, 'LIQUIDATED');
  assert.equal(out.companies[0].liquidated, '2019-06-08');
  assert.equal(out.companies[0].director, undefined);
});

test('dadata_party: nothing found is said plainly; a query that is not an ИНН or ОГРН is refused before any request', async () => {
  route(/findById\/party$/, { suggestions: [] });
  const c = await connect('dadata', ENV);
  assert.equal(textOf(await c.callTool({ name: 'dadata_party', arguments: { query: '7707083893' } })), 'Nothing found.');
  const n = calls.length;
  for (const bad of ['Сбербанк', '12345', '7707083893/12']) {
    const r = await c.callTool({ name: 'dadata_party', arguments: { query: bad } }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
    assert.equal(r.isError, true, bad);
  }
  assert.equal(calls.length, n);
});

test('dadata_address: suggest sends query and count, maps the address parts', async () => {
  route(/suggest\/address$/, {
    suggestions: [{
      value: 'г Москва, ул Хабаровская', unrestricted_value: '107241, г Москва, ул Хабаровская',
      data: {
        postal_code: '107241', region_with_type: 'г Москва', city_with_type: 'г Москва', street_with_type: 'ул Хабаровская', house: null,
        fias_id: '32fcb102-2a50-44c9-a00e-806420f448ea', fias_level: '7', kladr_id: '77000000000713400', geo_lat: '55.821168', geo_lon: '37.82608',
      },
    }],
  });
  const c = await connect('dadata', ENV);
  const n = calls.length;
  const out = await callJson(c, 'dadata_address', { query: 'москва хабар', limit: 3 });
  const [call] = sentSince(n);
  assert.equal(call.url, `${SUGGEST}/suggest/address`);
  assert.equal(call.init.headers.Authorization, 'Token key-1');
  assert.deepEqual(bodyOf(call), { query: 'москва хабар', count: 3 });
  assert.deepEqual(out.addresses, [{
    address: '107241, г Москва, ул Хабаровская', postalCode: '107241', region: 'г Москва', city: 'г Москва', street: 'ул Хабаровская',
    fiasId: '32fcb102-2a50-44c9-a00e-806420f448ea', fiasLevel: '7', kladrId: '77000000000713400', lat: '55.821168', lon: '37.82608',
  }]);
});

test('dadata_address: clean needs the secret key and never reaches the cleaner without it', async () => {
  const c = await connect('dadata', ENV);
  const n = calls.length;
  const r = await c.callTool({ name: 'dadata_address', arguments: { query: 'мск сухонска 11/-89', mode: 'clean' } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /DADATA_SECRET/);
  assert.equal(calls.length, n);
});

test('dadata_address: clean posts [query] with Token and X-Secret, keeps the quality codes (0 included)', async () => {
  route(/clean\/address$/, [{
    source: 'мск сухонска 11/-89', result: 'г Москва, ул Сухонская, д 11, кв 89', postal_code: '127642', region_with_type: 'г Москва',
    city_with_type: null, street_with_type: 'ул Сухонская', house: '11', flat: '89', fias_id: 'f26b876b-6857-4951-b060-ec6559f04a9a', fias_level: '9',
    kladr_id: '7700000000028360004', geo_lat: '55.8783089', geo_lon: '37.6537862', timezone: 'UTC+3', qc: 0, qc_geo: 0, qc_complete: 0, qc_house: 2, unparsed_parts: null,
  }]);
  const c = await connect('dadata', { ...ENV, DADATA_SECRET: 'secret-1' });
  const n = calls.length;
  const out = await callJson(c, 'dadata_address', { query: 'мск сухонска 11/-89', mode: 'clean' });
  const [call] = sentSince(n);
  assert.equal(call.url, `${CLEAN}/clean/address`);
  assert.equal(call.init.headers.Authorization, 'Token key-1');
  assert.equal(call.init.headers['X-Secret'], 'secret-1');
  assert.deepEqual(bodyOf(call), ['мск сухонска 11/-89']);
  assert.deepEqual(out.cleaned, {
    source: 'мск сухонска 11/-89', result: 'г Москва, ул Сухонская, д 11, кв 89', postalCode: '127642', region: 'г Москва', street: 'ул Сухонская',
    house: '11', flat: '89', fiasId: 'f26b876b-6857-4951-b060-ec6559f04a9a', fiasLevel: '9', kladrId: '7700000000028360004', lat: '55.8783089', lon: '37.6537862',
    timezone: 'UTC+3', qc: 0, qcGeo: 0, qcComplete: 0, qcHouse: 2,
  });
});

test('dadata_address: cleaning is not repeated after a 5xx (the record may have been billed)', async () => {
  route(/clean\/address$/, { message: 'busy' }, 503);
  const c = await connect('dadata', { ...ENV, DADATA_SECRET: 'secret-1' });
  const n = calls.length;
  const r = await c.callTool({ name: 'dadata_address', arguments: { query: 'москва', mode: 'clean' } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /HTTP 503: busy/);
  assert.equal(sentSince(n).length, 1);
});

test('dadata_bank: findById/bank by БИК, optional КПП; fields are mapped', async () => {
  route(/findById\/bank$/, {
    suggestions: [{
      value: 'ПАО Сбербанк',
      data: {
        name: { payment: 'ПАО СБЕРБАНК', short: 'ПАО Сбербанк' }, bic: '044525225', swift: 'SABRRUMM', inn: '7707083893', kpp: '773601001',
        correspondent_account: '30101810400000000225', registration_number: '1481', payment_city: 'г. Москва', opf: { type: 'BANK' },
        state: { status: 'ACTIVE', registration_date: 677376000000, liquidation_date: null }, address: { value: 'г Москва, ул Вавилова, д 19' }, okpo: null,
      },
    }],
  });
  const c = await connect('dadata', ENV);
  const n = calls.length;
  const out = await callJson(c, 'dadata_bank', { query: '044525225' });
  const [call] = sentSince(n);
  assert.equal(call.url, `${SUGGEST}/findById/bank`);
  assert.deepEqual(bodyOf(call), { query: '044525225' });
  assert.deepEqual(out.banks, [{
    name: 'ПАО Сбербанк', paymentName: 'ПАО СБЕРБАНК', bic: '044525225', swift: 'SABRRUMM', inn: '7707083893', kpp: '773601001',
    corrAccount: '30101810400000000225', regNumber: '1481', city: 'г. Москва', address: 'г Москва, ул Вавилова, д 19', type: 'BANK', status: 'ACTIVE',
  }]);
  await callJson(c, 'dadata_bank', { query: '7728168971', kpp: '667102002' });
  assert.deepEqual(bodyOf(calls.at(-1)), { query: '7728168971', kpp: '667102002' });
});

test('errors: the service message is shown; a 429 is repeated after Retry-After; the daily limit is not retried', async () => {
  route(/findById\/bank$/, (url, init, n) => (n === 0
    ? { status: 429, body: { message: 'Too many requests' }, headers: { 'retry-after': '0' } }
    : { suggestions: [] }));
  const c = await connect('dadata', ENV);
  const n = calls.length;
  assert.equal(textOf(await c.callTool({ name: 'dadata_bank', arguments: { query: '044525225' } })), 'Nothing found.');
  assert.equal(sentSince(n).length, 2);
  route(/findById\/party$/, { family: 'FORBIDDEN', reason: 'Forbidden', message: 'Daily request limit exceeded' }, 403);
  const m = calls.length;
  const r = await c.callTool({ name: 'dadata_party', arguments: { query: '7707083893' } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /HTTP 403: Daily request limit exceeded/);
  assert.equal(sentSince(m).length, 1);
});

test('not configured: the missing variable is named and nothing is sent; API urls can be overridden', async () => {
  const bare = await connect('dadata', {});
  const n = calls.length;
  const r = await bare.callTool({ name: 'dadata_bank', arguments: { query: '044525225' } });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /DADATA_API_KEY/);
  assert.equal(calls.length, n);
  route(/proxy\.test/, { suggestions: [] });
  const c = await connect('dadata', { ...ENV, DADATA_SUGGEST_URL: 'https://proxy.test/s/', DADATA_CLEAN_URL: 'https://proxy.test/c/', DADATA_SECRET: 'x' });
  await c.callTool({ name: 'dadata_bank', arguments: { query: '044525225' } });
  assert.equal(calls.at(-1).url, 'https://proxy.test/s/findById/bank');
  await c.callTool({ name: 'dadata_address', arguments: { query: 'москва', mode: 'clean' } });
  assert.equal(calls.at(-1).url, 'https://proxy.test/c/clean/address');
});

test('hosted: x-dadata-key and x-dadata-secret map into the env; bad values are refused', () => {
  assert.deepEqual(credentialsFor(SERVICES.dadata, { 'x-dadata-key': 'k-1', 'x-dadata-secret': 's-1' }), { env: { DADATA_API_KEY: 'k-1', DADATA_SECRET: 's-1' } });
  assert.deepEqual(credentialsFor(SERVICES.dadata, { 'x-dadata-key': 'k-1' }), { env: { DADATA_API_KEY: 'k-1' } });
  assert.match(credentialsFor(SERVICES.dadata, { 'x-dadata-key': 'two words' }).error, /x-dadata-key/);
  assert.match(credentialsFor(SERVICES.dadata, { 'x-dadata-secret': 'a\tb' }).error, /x-dadata-secret/);
});
