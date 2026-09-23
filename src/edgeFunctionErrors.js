const cleanMessage = value => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 500);
};

const messageFromPayload = payload => {
  if (!payload || typeof payload !== 'object') return '';
  return cleanMessage(payload.error) || cleanMessage(payload.message);
};

export const readFunctionInvocationError = async (result, fallback) => {
  const directMessage = messageFromPayload(result?.data);
  if (directMessage) return directMessage;

  const response = result?.error?.context;
  if (response && typeof response.clone === 'function') {
    try {
      const payload = await response.clone().json();
      const responseMessage = messageFromPayload(payload);
      if (responseMessage) return responseMessage;
    } catch {
      // The response may not be JSON. The SDK message remains a safe fallback.
    }
  }

  return cleanMessage(result?.error?.message) || fallback;
};
