import { createCostsRepository } from './modules/costs/costs.repository.mjs';
import { withOwnedBusinessContext } from './infrastructure/database/client.mjs';

export { pool, migrate } from './infrastructure/database/client.mjs';
export * from './modules/auth/auth.repository.mjs';
export * from './modules/stores/stores.repository.mjs';
export * from './modules/catalog/catalog.repository.mjs';
export * from './modules/expenses/expenses.repository.mjs';
export * from './modules/taxes/taxes.repository.mjs';
export * from './modules/reports/reports.repository.mjs';
export * from './modules/calculation/calculation.repository.mjs';
export * from './modules/operational/operational.repository.mjs';

export const { getCostState, importVariantCosts } = createCostsRepository({ withOwnedBusinessContext });
