// DaData (dadata.ru): company, bank and address lookups. API key and secret key: dadata.ru → profile.
// Lookups need the API key only; address cleaning (paid, 0.20 ₽ a record) needs the secret key as well.
import { isoDate, request, z } from '../core.mjs';

const SUGGEST_URL = 'https://suggestions.dadata.ru/suggestions/api/4_1/rs';
const CLEAN_URL = 'https://cleaner.dadata.ru/api/v1';
const QUERY_MAX_CHARS = 300; // longer queries are refused
const PARTY_MAX = 20; // the API allows 300 organizations, an agent does not need that many
const PARTY_DEFAULT = 5;
const ADDRESS_MAX = 20; // maximum of suggest/address
const ADDRESS_DEFAULT = 5;
const CONTACTS_SHOWN = 3;
/** ИНН of a company (10 digits) or a sole proprietor (12), ОГРН (13), ОГРНИП (15); «ИНН/КПП» finds one branch. */
const PARTY_QUERY = /^(?:\d{10}(?:\/\d{9})?|\d{12}|\d{13}|\d{15})$/;
/** БИК (9 digits), SWIFT (8 or 11 characters), ИНН (10 or 12 digits) or the number in the Bank of Russia register (up to 4). */
const BANK_QUERY = /^[A-Za-z0-9]{1,12}$/;
const KPP = /^\d{9}$/;

const suggestUrl = (env) => (env.DADATA_SUGGEST_URL || SUGGEST_URL).replace(/\/+$/, '');
const cleanUrl = (env) => (env.DADATA_CLEAN_URL || CLEAN_URL).replace(/\/+$/, '');
const auth = (env) => ({ Authorization: `Token ${env.DADATA_API_KEY}` });
/** DaData dates are Unix milliseconds. */
const day = (ms) => (Number.isFinite(ms) ? isoDate(ms) : undefined);
const contacts = (list) => (list ?? []).slice(0, CONTACTS_SHOWN).map((c) => c.value);

/** A suggestions API method: a read sent as POST, so network errors and 5xx may be retried. */
async function lookup(env, method, body) {
  const d = await request(`${suggestUrl(env)}/${method}`, { method: 'POST', headers: auth(env), body, idempotent: true });
  return d?.suggestions ?? [];
}

function partyOut(s) {
  const d = s.data ?? {};
  const f = d.finance;
  return {
    name: d.name?.short_with_opf ?? s.value,
    fullName: d.name?.full_with_opf,
    inn: d.inn,
    kpp: d.kpp,
    ogrn: d.ogrn,
    ogrnDate: day(d.ogrn_date),
    type: d.type,
    status: d.state?.status,
    registered: day(d.state?.registration_date),
    liquidated: day(d.state?.liquidation_date),
    address: d.address?.value,
    director: d.management?.name ? { name: d.management.name, post: d.management.post } : undefined,
    okved: d.okved,
    branchType: d.branch_type,
    branchCount: d.branch_count || undefined,
    employees: d.employee_count,
    finance: f ? { year: f.year, revenue: f.revenue, income: f.income, expense: f.expense, taxSystem: f.tax_system } : undefined,
    phones: contacts(d.phones),
    emails: contacts(d.emails),
    unreliable: d.invalid ? true : undefined,
  };
}

/** Address parts: suggest returns them in `data`, clean in the object itself — the field names are the same. */
const addressOut = (a = {}) => ({
  postalCode: a.postal_code,
  region: a.region_with_type,
  city: a.city_with_type ?? a.settlement_with_type,
  street: a.street_with_type,
  house: a.house,
  block: a.block,
  flat: a.flat,
  fiasId: a.fias_id,
  fiasLevel: a.fias_level,
  kladrId: a.kladr_id,
  lat: a.geo_lat,
  lon: a.geo_lon,
});

async function suggestAddress(env, query, limit) {
  const list = await lookup(env, 'suggest/address', { query, count: limit });
  return { addresses: list.map((s) => ({ address: s.unrestricted_value ?? s.value, ...addressOut(s.data) })) };
}

/** Standardization: one address per request, paid, needs the secret key; not repeated after a 5xx (it may be billed). */
async function cleanAddress(env, query) {
  if (!env.DADATA_SECRET) throw new Error('Address cleaning needs the secret key: set DADATA_SECRET (header x-dadata-secret).');
  const headers = { ...auth(env), 'X-Secret': env.DADATA_SECRET };
  const d = await request(`${cleanUrl(env)}/clean/address`, { method: 'POST', headers, body: [query] });
  const a = Array.isArray(d) ? d[0] : null;
  if (!a) return {};
  return {
    cleaned: {
      source: a.source, result: a.result, ...addressOut(a), timezone: a.timezone,
      qc: a.qc, qcGeo: a.qc_geo, qcComplete: a.qc_complete, qcHouse: a.qc_house, unparsed: a.unparsed_parts,
    },
  };
}

function bankOut(s) {
  const d = s.data ?? {};
  return {
    name: s.value,
    paymentName: d.name?.payment,
    bic: d.bic,
    swift: d.swift,
    inn: d.inn,
    kpp: d.kpp,
    corrAccount: d.correspondent_account,
    regNumber: d.registration_number,
    city: d.payment_city,
    address: d.address?.value,
    type: d.opf?.type,
    status: d.state?.status,
  };
}

export default {
  name: 'dadata',
  title: 'DaData',
  env: ['DADATA_API_KEY'],
  optionalEnv: ['DADATA_SECRET'],
  tools: [
    {
      name: 'dadata_party',
      description: 'Company or sole proprietor by ИНН or ОГРН: name, status (ACTIVE, LIQUIDATING, LIQUIDATED, BANKRUPT, REORGANIZING), '
        + 'registration and liquidation dates, address, director, main ОКВЭД, branches. Finance, headcount and tax system '
        + 'are filled on the DaData plans that include them.',
      input: {
        query: z.string().trim().regex(PARTY_QUERY, 'Expected ИНН (10 digits, 12 for a sole proprietor), ОГРН (13) or ОГРНИП (15); ИНН/КПП for one branch')
          .describe('ИНН, ОГРН, ОГРНИП or ИНН/КПП'),
        kpp: z.string().trim().regex(KPP, 'КПП is 9 digits').optional().describe('KPP of one branch (or pass the query as ИНН/КПП)'),
        limit: z.number().int().min(1).max(PARTY_MAX).optional().describe(`Organizations, default ${PARTY_DEFAULT}; a company with branches returns several`),
      },
      run: async ({ query, kpp, limit = PARTY_DEFAULT }, env) => {
        const list = await lookup(env, 'findById/party', { query, count: limit, ...(kpp ? { kpp } : {}) });
        return { companies: list.map(partyOut) };
      },
    },
    {
      name: 'dadata_address',
      description: 'Address lookup. mode=suggest (default): up to `limit` matching addresses with postal code, FIAS and KLADR ids, coordinates. '
        + 'mode=clean: standardizes ONE address with quality codes (qc 0 — recognized confidently, 1 or 3 — check by hand, 2 — junk); '
        + 'it is paid (0.20 ₽ per address) and needs DADATA_SECRET.',
      input: {
        query: z.string().trim().min(1).max(QUERY_MAX_CHARS).describe('Address or a part of it, e.g. "самара авроры 7 12"'),
        mode: z.enum(['suggest', 'clean']).optional(),
        limit: z.number().int().min(1).max(ADDRESS_MAX).optional().describe(`Suggestions, default ${ADDRESS_DEFAULT} (suggest mode only)`),
      },
      run: ({ query, mode = 'suggest', limit = ADDRESS_DEFAULT }, env) => (mode === 'clean' ? cleanAddress(env, query) : suggestAddress(env, query, limit)),
    },
    {
      name: 'dadata_bank',
      description: 'Bank by БИК, SWIFT, ИНН or registration number (add kpp for a branch): payment name, БИК, correspondent account, '
        + 'ИНН/КПП, address, status. Exact match only.',
      input: {
        query: z.string().trim().regex(BANK_QUERY, 'Expected БИК (9 digits), SWIFT, ИНН or the Bank of Russia registration number').describe('БИК, SWIFT, ИНН or registration number'),
        kpp: z.string().trim().regex(KPP, 'КПП is 9 digits').optional().describe('KPP of a branch, with the ИНН'),
      },
      run: async ({ query, kpp }, env) => {
        const list = await lookup(env, 'findById/bank', { query, ...(kpp ? { kpp } : {}) });
        return { banks: list.map(bankOut) };
      },
    },
  ],
};
