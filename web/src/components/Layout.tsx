import { NavLink, Outlet } from 'react-router-dom';

const links = [
  { to: '/history', label: 'История цен' },
  { to: '/stats', label: 'Статистика' },
  { to: '/evaluate', label: 'Оценка лота' },
  { to: '/combos', label: 'Комбинации' },
  { to: '/liquidity', label: 'Ликвидность' },
  { to: '/scanner', label: 'Сканер / радар' },
  { to: '/settings', label: 'Настройки' },
];

export default function Layout() {
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="logo">MRKT Admin</div>
        <nav>
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === '/'}
              className={({ isActive }) =>
                isActive ? 'nav-link active' : 'nav-link'
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}