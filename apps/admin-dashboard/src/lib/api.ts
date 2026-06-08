import axios from 'axios';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1',
  timeout: 30000,
  // 不设置默认 Content-Type — axios 会根据数据类型自动设置:
  //   普通对象/数组 → application/json
  //   FormData      → multipart/form-data (浏览器自动加 boundary)
  //   URLSearchParams → application/x-www-form-urlencoded
});

api.interceptors.request.use((config) => {
  const traceId = crypto.randomUUID();
  config.headers['X-Trace-Id'] = traceId;
  return config;
});

/**
 * Response 解包: 后端部分端点用 `{ success: true, data: ... }` 信封,
 * 部分端点用 `{ success, configs | taskId | ... }` 平铺字段。
 * 本 interceptor 仅在响应同时满足以下条件时解包到 data:
 *   1. body 是普通对象
 *   2. body.success === true
 *   3. body 显式包含 'data' 字段
 * 这样 `r.data` 就能直接拿到真实负载,前端 hook 不必各自展开。
 */
api.interceptors.response.use(
  (res) => {
    const body: any = res.data;
    if (
      body &&
      typeof body === 'object' &&
      body.success === true &&
      'data' in body
    ) {
      res.data = body.data;
    }
    return res;
  },
  (err) => {
    console.error(`API Error: ${err.config?.url}`, err.message);
    return Promise.reject(err);
  },
);

export default api;
