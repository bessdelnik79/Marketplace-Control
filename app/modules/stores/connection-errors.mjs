// Only this constraint identifies an already connected WB account.
export function isWbStoreAlreadyAdded(error) {
  return error?.code === '23505'
    && error?.constraint === 'stores_business_id_marketplace_code_external_account_id_key';
}
