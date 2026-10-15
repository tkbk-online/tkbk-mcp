import wildberries from './services/wildberries.mjs';
import ozon from './services/ozon.mjs';
import yandexMarket from './services/yandex-market.mjs';
import bitrix24 from './services/bitrix24.mjs';
import amocrm from './services/amocrm.mjs';
import avito from './services/avito.mjs';
import dadata from './services/dadata.mjs';
import yandexDirect from './services/yandex-direct.mjs';
import yandexMetrika from './services/yandex-metrika.mjs';

/** CLI names (`tkbk-mcp <name>`) and hosted names (`/mcp/<name>`) of the services. */
export const SERVICES = {
  wb: wildberries, wildberries,
  ozon,
  'yandex-market': yandexMarket, ym: yandexMarket,
  bitrix24, b24: bitrix24,
  amocrm, amo: amocrm,
  avito,
  dadata,
  'yandex-direct': yandexDirect, direct: yandexDirect,
  'yandex-metrika': yandexMetrika, metrika: yandexMetrika,
};
export { buildServer } from './core.mjs';
