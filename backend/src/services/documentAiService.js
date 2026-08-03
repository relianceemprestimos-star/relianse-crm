function getDocumentAiConfig() {
  return {
    enabled: String(process.env.DOCUMENT_AI_ENABLED || 'false').toLowerCase() === 'true',
    projectId: String(process.env.DOCUMENT_AI_PROJECT_ID || ''),
    location: String(process.env.DOCUMENT_AI_LOCATION || 'us'),
    processorId: String(process.env.DOCUMENT_AI_PROCESSOR_ID || ''),
  };
}

export function getDocumentAiStatus() {
  const config = getDocumentAiConfig();
  return {
    enabled: config.enabled,
    configured: Boolean(config.projectId && config.location && config.processorId),
    project_id_configured: Boolean(config.projectId),
    location: config.location || '',
    processor_id_configured: Boolean(config.processorId),
    credentials_configured: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_CLOUD_PROJECT),
  };
}

export async function processDocumentWithGoogleAi({ buffer, mimeType }) {
  const config = getDocumentAiConfig();
  if (!config.enabled) {
    const error = new Error('Document AI esta desativado. Configure DOCUMENT_AI_ENABLED=true.');
    error.code = 'DOCUMENT_AI_DISABLED';
    throw error;
  }
  if (!config.projectId || !config.location || !config.processorId) {
    const error = new Error('Document AI nao configurado. Informe DOCUMENT_AI_PROJECT_ID, DOCUMENT_AI_LOCATION e DOCUMENT_AI_PROCESSOR_ID.');
    error.code = 'DOCUMENT_AI_NOT_CONFIGURED';
    throw error;
  }

  const { v1 } = await import('@google-cloud/documentai');
  const endpoint = `${config.location}-documentai.googleapis.com`;
  const client = new v1.DocumentProcessorServiceClient({
    apiEndpoint: endpoint,
  });
  const name = client.processorPath(config.projectId, config.location, config.processorId);
  const [result] = await client.processDocument({
    name,
    rawDocument: {
      content: buffer.toString('base64'),
      mimeType: mimeType || 'application/pdf',
    },
  });

  const document = result.document || {};
  const entities = Array.isArray(document.entities)
    ? document.entities.map((entity) => ({
        type: entity.type || '',
        mentionText: entity.mentionText || '',
        confidence: entity.confidence || 0,
        normalizedValue: entity.normalizedValue?.text || '',
      }))
    : [];

  return {
    text: document.text || '',
    entities,
    pages: Array.isArray(document.pages) ? document.pages.length : 0,
    mimeType: mimeType || '',
  };
}
