interface Props {
  label: string;
  value: React.ReactNode;
  hint?: string;
}

export default function StatCard({ label, value, hint }: Props) {
  return (
    <div className="stat-card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="label" style={{ marginTop: 6 }}>{hint}</div>}
    </div>
  );
}