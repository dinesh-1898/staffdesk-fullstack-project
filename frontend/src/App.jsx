import { useEffect, useState } from 'react';
import { api } from './api';

const empty = { name: '', email: '', department: '', position: '', status: 'Active' };

function Login({ onLogin }) {
  const [email, setEmail] = useState('admin@staffdesk.com');
  const [password, setPassword] = useState('Admin@123');
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault(); setErr('');
    try {
      const { token, user } = await api('/auth/login', { method: 'POST', body: { email, password } });
      localStorage.setItem('token', token); onLogin(user);
    } catch (e) { setErr(e.message); }
  };
  return (
    <div className="center">
      <form className="card" onSubmit={submit}>
        <h1>StaffDesk</h1><p className="muted">Sign in to manage your staff</p>
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" />
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" />
        {err && <div className="error">{err}</div>}
        <button>Login</button>
      </form>
    </div>
  );
}

function Dashboard({ user, onLogout }) {
  const [staff, setStaff] = useState([]);
  const [form, setForm] = useState(empty);
  const [editId, setEditId] = useState(null);
  const [search, setSearch] = useState('');
  const [err, setErr] = useState('');

  const load = async () => {
    try { setStaff(await api(`/staff?search=${encodeURIComponent(search)}`)); }
    catch (e) { if (e.message === 'Unauthorized') onLogout(); else setErr(e.message); }
  };
  useEffect(() => { load(); }, [search]);

  const save = async (e) => {
    e.preventDefault(); setErr('');
    try {
      editId ? await api(`/staff/${editId}`, { method: 'PUT', body: form })
             : await api('/staff', { method: 'POST', body: form });
      setForm(empty); setEditId(null); load();
    } catch (e) { setErr(e.message); }
  };
  const remove = async (id) => { if (confirm('Delete this staff member?')) { await api(`/staff/${id}`, { method: 'DELETE' }); load(); } };
  const edit = (s) => { setEditId(s.id); setForm({ name: s.name, email: s.email, department: s.department, position: s.position, status: s.status }); };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="wrap">
      <header><h1>StaffDesk</h1><div>Hi, {user.name} <button className="ghost" onClick={onLogout}>Logout</button></div></header>
      <form className="card row" onSubmit={save}>
        <input placeholder="Name" value={form.name} onChange={set('name')} />
        <input placeholder="Email" value={form.email} onChange={set('email')} />
        <input placeholder="Department" value={form.department} onChange={set('department')} />
        <input placeholder="Position" value={form.position} onChange={set('position')} />
        <select value={form.status} onChange={set('status')}><option>Active</option><option>On Leave</option><option>Inactive</option></select>
        <button>{editId ? 'Update' : 'Add Staff'}</button>
      </form>
      {err && <div className="error">{err}</div>}
      <input className="search" placeholder="Search name, email, department..." value={search} onChange={e => setSearch(e.target.value)} />
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Department</th><th>Position</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {staff.map(s => (
            <tr key={s.id}>
              <td>{s.name}</td><td>{s.email}</td><td>{s.department}</td><td>{s.position}</td>
              <td><span className={`tag ${s.status.replace(' ', '')}`}>{s.status}</span></td>
              <td><button className="ghost" onClick={() => edit(s)}>Edit</button><button className="danger" onClick={() => remove(s.id)}>Delete</button></td>
            </tr>
          ))}
          {!staff.length && <tr><td colSpan="6" className="muted">No staff yet. Add one above.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    if (!localStorage.getItem('token')) return setChecking(false);
    api('/auth/me').then(d => setUser(d.user)).catch(() => localStorage.removeItem('token')).finally(() => setChecking(false));
  }, []);
  const logout = () => { localStorage.removeItem('token'); setUser(null); };
  if (checking) return null;
  return user ? <Dashboard user={user} onLogout={logout} /> : <Login onLogin={setUser} />;
}
