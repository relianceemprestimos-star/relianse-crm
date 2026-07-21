export const MANUAL_PROVIDER = 'MANUAL';

export async function solveManual(context = {}, reason = 'Este portal exige validação manual.') {
  return {
    ok: false,
    provider: MANUAL_PROVIDER,
    status: 'MANUAL_AUTH_REQUIRED',
    code: 'MANUAL_AUTH_REQUIRED',
    message: reason,
    context: {
      portal: context.portal || '',
      batchId: context.batchId || context.batch_id || null,
      cpfMasked: context.cpfMasked || context.cpf_masked || '',
    },
  };
}
