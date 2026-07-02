import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  }
);

const API = import.meta.env.VITE_API_URL;

async function authHeaders() {
  let { data: { session } } = await supabase.auth.getSession();

  const expiresAt = session?.expires_at;
  const isExpiringSoon = !expiresAt || (expiresAt * 1000 - Date.now()) < 60000;

  if (!session || isExpiringSoon) {
    const { data, error } = await supabase.auth.refreshSession();
    if (!error && data.session) session = data.session;
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session?.access_token}`,
  };
}

async function apiFetch(path, options = {}, _isRetry = false) {
  const headers = await authHeaders();
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  });

  if (res.status === 401 && !_isRetry) {
    await supabase.auth.refreshSession();
    return apiFetch(path, options, true);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.status === 204 ? null : res.json();
}

export const api = {
  conferences: {
    list:   ()       => apiFetch('/api/conferences'),
    get:    (id)     => apiFetch(`/api/conferences/${id}`),
    create: (data)   => apiFetch('/api/conferences', { method:'POST', body:JSON.stringify(data) }),
    update: (id, d)  => apiFetch(`/api/conferences/${id}`, { method:'PATCH', body:JSON.stringify(d) }),
    delete: (id)     => apiFetch(`/api/conferences/${id}`, { method:'DELETE' }),
    budget: (id, items) => apiFetch(`/api/conferences/${id}/budget`, { method:'POST', body:JSON.stringify({ items }) }),
    roi:    ()       => apiFetch('/api/conferences/roi'),
    addAttachment:    (id, d) => apiFetch(`/api/conferences/${id}/attachments`, { method:'POST', body:JSON.stringify(d) }),
    deleteAttachment: (id, attachmentId) => apiFetch(`/api/conferences/${id}/attachments/${attachmentId}`, { method:'DELETE' }),
    listExpenses:     (id)    => apiFetch(`/api/conferences/${id}/expenses`),
    addExpense:       (id, d) => apiFetch(`/api/conferences/${id}/expenses`, { method:'POST', body:JSON.stringify(d) }),
    updateExpense:    (id, expenseId, d) => apiFetch(`/api/conferences/${id}/expenses/${expenseId}`, { method:'PATCH', body:JSON.stringify(d) }),
    deleteExpense:    (id, expenseId) => apiFetch(`/api/conferences/${id}/expenses/${expenseId}`, { method:'DELETE' }),
  },
  leads: {
    list:   (params={}) => {
      const q = new URLSearchParams(params).toString();
      return apiFetch(`/api/leads${q ? '?'+q : ''}`);
    },
    update: (id, d)  => apiFetch(`/api/leads/${id}`, { method:'PATCH', body:JSON.stringify(d) }),
    followUp: (id, d) => apiFetch(`/api/leads/${id}/follow-ups`, { method:'POST', body:JSON.stringify(d) }),
  },
  assets: {
    list:   (params={}) => {
      const q = new URLSearchParams(params).toString();
      return apiFetch(`/api/assets${q ? '?'+q : ''}`);
    },
    create: (d)      => apiFetch('/api/assets', { method:'POST', body:JSON.stringify(d) }),
    update: (id, d)  => apiFetch(`/api/assets/${id}`, { method:'PATCH', body:JSON.stringify(d) }),
    delete: (id)     => apiFetch(`/api/assets/${id}`, { method:'DELETE' }),
  },
  assetCatalog: {
    search: (q='')   => apiFetch(`/api/asset-catalog${q ? '?search='+encodeURIComponent(q) : ''}`),
    create: (d)      => apiFetch('/api/asset-catalog', { method:'POST', body:JSON.stringify(d) }),
    delete: (id)     => apiFetch(`/api/asset-catalog/${id}`, { method:'DELETE' }),
  },
  tasks: {
    list:   (params={}) => {
      const q = new URLSearchParams(params).toString();
      return apiFetch(`/api/tasks${q ? '?'+q : ''}`);
    },
    create: (d)      => apiFetch('/api/tasks', { method:'POST', body:JSON.stringify(d) }),
    update: (id, d)  => apiFetch(`/api/tasks/${id}`, { method:'PATCH', body:JSON.stringify(d) }),
    delete: (id)     => apiFetch(`/api/tasks/${id}`, { method:'DELETE' }),
  },
  users: {
    me:     ()       => apiFetch('/api/users/me'),
    list:   ()       => apiFetch('/api/users'),
    create: (d)      => apiFetch('/api/users', { method:'POST', body:JSON.stringify(d) }),
    updateRole: (id, role) => apiFetch(`/api/users/${id}/role`, { method:'PATCH', body:JSON.stringify({ role }) }),
    delete: (id)     => apiFetch(`/api/users/${id}`, { method:'DELETE' }),
    assign: (d)      => apiFetch('/api/users/assign', { method:'POST', body:JSON.stringify(d) }),
    unassign: (d)    => apiFetch('/api/users/assign', { method:'DELETE', body:JSON.stringify(d) }),
    // Updates travel/lodging fields on an existing staff assignment (by its
    // own id) — kept separate from assign() so it never touches role.
    updateAssignment: (id, d) => apiFetch(`/api/users/assign/${id}`, { method:'PATCH', body:JSON.stringify(d) }),
  },
  sync: {
    status: ()       => apiFetch('/api/sync/status'),
    run:    ()       => apiFetch('/api/sync/run', { method:'POST' }),
  },
};
