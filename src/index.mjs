import wildberries from './services/wildberries.mjs';
import ozon from './services/ozon.mjs';
import yandexMarket from './services/yandex-market.mjs';
import bitrix24 from './services/bitrix24.mjs';
import amocrm from './services/amocrm.mjs';

export const SERVICES = { wb: wildberries, wildberries, ozon, 'yandex-market': yandexMarket, ym: yandexMarket, bitrix24, b24: bitrix24, amocrm, amo: amocrm };
export { buildServer } from './core.mjs';
