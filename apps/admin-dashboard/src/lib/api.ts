import axios from 'axios';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const traceId = crypto.randomUUID();
  config.headers['X-Trace-Id'] = traceId;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    console.error(`API Error: ${err.config?.url}`, err.message);
    return Promise.reject(err);
  },
);

export default api;
