import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import { Settings } from './pages/Settings';
import { Evaluate } from './pages/Evaluate';
import { Stats } from './pages/Stats';
import { History } from './pages/History';
import { Liquidity } from './pages/Liquidity';
import { Scanner } from './pages/Scanner';
import { Combos } from './pages/Combos';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/history" replace />} />
        <Route path="/stats" element={<Stats />} />
        <Route path="/history" element={<History />} />
        <Route path="/evaluate" element={<Evaluate />} />
        <Route path="/combos" element={<Combos />} />
        <Route path="/liquidity" element={<Liquidity />} />
        <Route path="/scanner" element={<Scanner />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/history" replace />} />
      </Route>
    </Routes>
  );
}
