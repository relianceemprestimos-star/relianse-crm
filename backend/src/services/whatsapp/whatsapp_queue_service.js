import { createWhatsappSendJobRecord, listWhatsappSendJobs, updateWhatsappSendJobRecord } from '../../db.js';
import { sendWhatsappMessage } from './whatsapp_service.js';

export function enqueueWhatsappSendJob(input = {}, userId = null) {
  return createWhatsappSendJobRecord({
    client_id: input.client_id ?? null,
    phone: input.phone || '',
    template_id: input.template_id ?? null,
    message_body: input.message_body || '',
    status: input.status || 'pending',
    scheduled_at: input.scheduled_at ?? null,
    created_by: userId,
  });
}

export async function runWhatsappQueue({ max = 10, userId = null } = {}) {
  const pending = listWhatsappSendJobs({ status: 'pending', limit: Math.max(1, Number(max || 10)) });
  const results = [];
  for (const row of pending) {
    try {
      updateWhatsappSendJobRecord(row.id, { status: 'running' });
      const result = await sendWhatsappMessage({
        clientId: row.client_id,
        phone: row.phone,
        message: row.message_body,
        templateId: row.template_id,
        userId,
      });
      updateWhatsappSendJobRecord(row.id, { status: 'sent', sent_at: new Date().toISOString() });
      results.push({ id: row.id, status: 'sent', result });
    } catch (error) {
      updateWhatsappSendJobRecord(row.id, { status: 'failed', error_message: error instanceof Error ? error.message : 'Erro na fila.' });
      results.push({ id: row.id, status: 'failed', error: error instanceof Error ? error.message : 'Erro na fila.' });
    }
  }
  return { processed: results.length, results };
}
