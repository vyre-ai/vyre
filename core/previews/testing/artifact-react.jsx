import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { ClipboardList } from "lucide-react";

// A React page written for Claude's artifact runtime: state, a chart, an icon, stored data through claude.use("db"), designing for absence.
export default function App() {
  const [tasks, setTasks] = useState([]);
  const [db, setDb] = useState(null);
  const [title, setTitle] = useState("");
  useEffect(() => {
    let off = () => {};
    window.claude.use("db").then((d) => {
      if (!d) return;
      setDb(d);
      off = d.collection("tasks").orderBy("n").onSnapshot((snap) => setTasks(snap.docs.map((x) => ({ id: x.id, ...x.data() }))));
    });
    return () => off();
  }, []);
  const data = [{ name: "Open", n: tasks.filter((t) => !t.done).length }, { name: "Done", n: tasks.filter((t) => t.done).length }];
  return (
    <div className="mx-auto max-w-xl p-6">
      <h1 className="flex items-center gap-2 text-2xl font-semibold"><ClipboardList size={24} /> React tasks</h1>
      <form className="my-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (db && title.trim()) { db.collection("tasks").add({ title: title.trim(), done: false, n: Date.now() }); setTitle(""); } }}>
        <input aria-label="New task" className="flex-1 rounded border p-2" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" />
        <button className="rounded bg-indigo-600 px-4 text-white" type="submit">Add</button>
      </form>
      <ul className="space-y-2">{tasks.map((t) => <li key={t.id} className="rounded border p-2">{t.title}</li>)}</ul>
      <div style={{ height: 180 }} aria-label="Tasks by state"><ResponsiveContainer width="100%" height="100%"><BarChart data={data}><XAxis dataKey="name" /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="n" fill="#4b3fcf" /></BarChart></ResponsiveContainer></div>
    </div>
  );
}
