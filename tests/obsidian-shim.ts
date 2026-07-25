type RequestOptions = {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
}

export async function requestUrl(options: RequestOptions) {
  const response = await fetch(options.url, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  })
  const text = await response.text()
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value
  })
  return {
    status: response.status,
    headers,
    text,
  }
}
