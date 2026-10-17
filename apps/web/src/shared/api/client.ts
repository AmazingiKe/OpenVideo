const api_base_url = import.meta.env.VITE_API_BASE_URL ?? "";

export { api_base_url };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function request_response(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(`${api_base_url}${path}`, init);
  if (!response.ok) throw await response_error(response);
  return response;
}

export async function response_error(response: Response): Promise<ApiError> {
  let message = `请求失败（${response.status}）`;
  try {
    const payload = (await response.json()) as {
      detail?: string;
      message?: string;
    };
    if (payload.message) message = payload.message;
    else if (payload.detail) message = payload.detail;
  } catch {
    // 非 JSON 错误仍保留状态码，避免解析失败掩盖真实请求错误。
  }
  return new ApiError(message, response.status);
}

export async function request_json<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await request_response(path, init);
  return (await response.json()) as T;
}
