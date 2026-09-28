import { createCostsRepository } from './modules/costs/costs.repository.mjs';
import { createJobsRepository } from './infrastructure/jobs/jobs.repository.mjs';
import { createFinancialInventoryRepository } from './modules/reports/financial-inventory.repository.mjs';
import { createFinancialPipelineRepository } from './modules/reports/financial-pipeline.repository.mjs';
import { createFinancialDailyGenerationRepository } from './modules/calculation/daily-generation.repository.mjs';
import { createFinancialScheduler } from './modules/reports/financial-scheduler.mjs';
import { pool, withOwnedBusinessContext } from './infrastructure/database/client.mjs';

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
export const jobsRepository = createJobsRepository({ pool, withOwnedBusinessContext });
export const { enqueueJob, claimJobs, heartbeatJob, completeJob, failJob } = jobsRepository;
export const financialInventoryRepository = createFinancialInventoryRepository({ pool });
export const financialPipelineRepository = createFinancialPipelineRepository({ pool });
export const financialDailyGenerationRepository = createFinancialDailyGenerationRepository({ pool });
export const { scheduleDue: scheduleDueFinancialInventory } = createFinancialScheduler({ pool });
