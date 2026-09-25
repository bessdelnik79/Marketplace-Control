import { decimal } from './finance.mjs';

const scale = 1000000000000n;

export const sellerOffsetLines = Object.freeze([
  { code: 'wb_reward_without_vat', label: 'Вознаграждение WB без НДС', field: 'vw' },
  { code: 'wb_reward_vat', label: 'НДС с вознаграждения WB', field: 'vwNds' },
  { code: 'loyalty_program_cost', label: 'Стоимость участия в программе лояльности', field: 'cashbackCommissionChange' },
  { code: 'loyalty_program_vat', label: 'НДС со стоимости участия в программе лояльности', field: null },
  { code: 'payment_organization_withholding', label: 'Удержание в счёт обеспечения организации платежа', field: 'acquiringFee' },
  { code: 'operational_processing_reimbursement', label: 'Возмещение издержек по перемещению и операционной обработке', field: 'rebillLogisticCost' },
  { code: 'pickup_point_issue_return', label: 'Возмещение за выдачу и возврат на ПВЗ', field: 'ppvzReward' },
  { code: 'penalties', label: 'Штрафы', field: 'penalty' },
  { code: 'other_withholdings', label: 'Прочие удержания', field: 'deduction' }
]);

function units(value) {
  if (value === null || value === undefined || value === '') return 0n;
  const normalized = decimal(value);
  const negative = normalized.startsWith('-');
  const [whole, fraction = ''] = normalized.replace('-', '').split('.');
  if (fraction.length > 12) throw new Error('seller_offset_amount_invalid');
  const result = BigInt(whole) * scale + BigInt(fraction.padEnd(12, '0') || '0');
  return negative ? -result : result;
}

function formatted(value) {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / scale;
  const fraction = String(magnitude % scale).padStart(12, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function buildSellerOffsetReference({ reportId, rows = [] }) {
  const expectedReportId = String(reportId ?? '');
  if (!/^\d+$/.test(expectedReportId)) throw new Error('seller_offset_report_invalid');
  if (!Array.isArray(rows)) throw new Error('seller_offset_rows_invalid');
  for (const row of rows) {
    if (!row || typeof row !== 'object' || String(row.reportId ?? '') !== expectedReportId) {
      throw new Error('seller_offset_report_mismatch');
    }
  }

  const lines = sellerOffsetLines.map(definition => {
    if (!definition.field) return { code: definition.code, label: definition.label, status: 'unverified', candidateAmount: null, sourceField: null };
    if(!rows.some(row=>row[definition.field]!==null&&row[definition.field]!==undefined&&row[definition.field]!=='')){
      return { code: definition.code, label: definition.label, status: 'source_missing', candidateAmount: null, sourceField: definition.field };
    }
    try {
      const amount = rows.reduce((sum, row) => sum + units(row[definition.field]), 0n);
      return { code: definition.code, label: definition.label, status: 'unverified', candidateAmount: formatted(amount), sourceField: definition.field };
    } catch {
      return { code: definition.code, label: definition.label, status: 'invalid_source', candidateAmount: null, sourceField: definition.field };
    }
  });

  return {
    reportId: expectedReportId,
    status: 'not_determined',
    total: null,
    reason: 'seller_offset_method_unverified',
    lines
  };
}
