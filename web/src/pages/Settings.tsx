import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getParseConfig, saveParseConfig } from '@/api/client';
import ErrorBox from '@/components/ErrorBox';
import Loading from '@/components/Loading';
import StickerThumb from '@/components/StickerThumb';
import { useCatalog } from '@/hooks/useCatalog';
import { mrktStickerUrl } from '@/lib/images';
import {
  feePercentFromRate,
  feeRateFromPercent,
  useSettings,
} from '@/store/settings';

function enabledSetFromApi(
  collections: string[],
  enabledCollections: string[] | null,
): Set<string> {
  if (enabledCollections === null) return new Set(collections);
  return new Set(enabledCollections);
}

export function Settings() {
  const {
    adminToken,
    setAdminToken,
    defaultDays,
    defaultFeeRate,
    setDefaultDays,
    setDefaultFeeRate,
  } = useSettings();
  const [localAdminToken, setLocalAdminToken] = useState(adminToken);

  const catalog = useCatalog();
  const parseQuery = useQuery({
    queryKey: ['parse-config'],
    queryFn: getParseConfig,
  });

  const collectionThumbs = catalog.data?.collectionThumbnails ?? {};

  const [localDays, setLocalDays] = useState(String(defaultDays));
  const [localFeePercent, setLocalFeePercent] = useState(
    String(feePercentFromRate(defaultFeeRate)),
  );
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [historyFetchBackdrops, setHistoryFetchBackdrops] = useState(true);
  const [localDelayMs, setLocalDelayMs] = useState('400');
  const [localFeedPages, setLocalFeedPages] = useState('5');
  const [localHistoryRoundMs, setLocalHistoryRoundMs] = useState('1200');
  const [salingScannerEnabled, setSalingScannerEnabled] = useState(false);
  const [localSalingIntervalMs, setLocalSalingIntervalMs] = useState('3000');
  const [localSalingJitterMs, setLocalSalingJitterMs] = useState('1000');
  const [localSalingModelDelayMs, setLocalSalingModelDelayMs] = useState('5000');
  const [buyDiscountPct, setBuyDiscountPct] = useState('8');
  const [buyMarginPct, setBuyMarginPct] = useState('4');
  const [watchDiscountPct, setWatchDiscountPct] = useState('4');
  const [parseDirty, setParseDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const collections = parseQuery.data?.collections ?? [];

  useEffect(() => {
    if (!parseQuery.data || parseDirty) return;
    setChecked(
      enabledSetFromApi(
        parseQuery.data.collections,
        parseQuery.data.enabledCollections,
      ),
    );
    setHistoryFetchBackdrops(parseQuery.data.historyFetchBackdrops);
    setLocalDelayMs(String(parseQuery.data.parserDelayMs));
    setLocalFeedPages(String(parseQuery.data.parserFeedPages));
    setLocalHistoryRoundMs(String(parseQuery.data.parserHistoryRoundMs));
    setSalingScannerEnabled(parseQuery.data.salingScannerEnabled);
    const st = parseQuery.data.salingScannerTiming;
    if (st) {
      setLocalSalingIntervalMs(String(st.intervalMs));
      setLocalSalingJitterMs(String(st.jitterMs));
      setLocalSalingModelDelayMs(String(st.modelDelayMs));
    }
    const fee = parseQuery.data.feeRate ?? 0.02;
    setLocalFeePercent(String(feePercentFromRate(fee)));
    setDefaultFeeRate(fee);
    const t = parseQuery.data.salesVerdictThresholds;
    setBuyDiscountPct(String(feePercentFromRate(t.buyMinDiscount)));
    setBuyMarginPct(String(feePercentFromRate(t.buyMinMargin)));
    setWatchDiscountPct(String(feePercentFromRate(t.watchMinDiscount)));
  }, [parseQuery.data, parseDirty, setDefaultFeeRate]);

  const allSelected = useMemo(
    () =>
      collections.length > 0 && collections.every((c) => checked.has(c)),
    [collections, checked],
  );

  function toggleCollection(name: string) {
    setParseDirty(true);
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function selectAll(on: boolean) {
    setParseDirty(true);
    setChecked(on ? new Set(collections) : new Set());
  }

  async function save() {
    setSaveError(null);
    setSaving(true);
    const days = Math.max(1, Math.floor(Number(localDays) || 7));
    const feePercent = Number(localFeePercent);
    const feeRate = Number.isFinite(feePercent)
      ? feeRateFromPercent(feePercent)
      : defaultFeeRate;
    setDefaultDays(days);
    setDefaultFeeRate(feeRate);
    try {
      const delayMs = Math.min(
        60_000,
        Math.max(50, Math.floor(Number(localDelayMs) || 400)),
      );
      const feedPages = Math.min(
        50,
        Math.max(1, Math.floor(Number(localFeedPages) || 5)),
      );
      const historyRoundMs = Math.min(
        3_600_000,
        Math.max(0, Math.floor(Number(localHistoryRoundMs) || 0)),
      );
      const buyMinDiscount = feeRateFromPercent(Number(buyDiscountPct) || 8);
      const buyMinMargin = feeRateFromPercent(Number(buyMarginPct) || 4);
      const watchMinDiscount = feeRateFromPercent(Number(watchDiscountPct) || 4);
      const salingScannerIntervalMs = Math.min(
        60_000,
        Math.max(200, Math.floor(Number(localSalingIntervalMs) || 3000)),
      );
      const salingScannerJitterMs = Math.min(
        30_000,
        Math.max(0, Math.floor(Number(localSalingJitterMs) || 0)),
      );
      const salingScannerModelDelayMs = Math.min(
        60_000,
        Math.max(50, Math.floor(Number(localSalingModelDelayMs) || 5000)),
      );
      await saveParseConfig({
        enabledCollections: [...checked].sort((a, b) =>
          a.localeCompare(b, 'ru'),
        ),
        historyFetchBackdrops,
        parserDelayMs: delayMs,
        parserFeedPages: feedPages,
        parserHistoryRoundMs: historyRoundMs,
        salingScannerEnabled,
        salingScannerIntervalMs,
        salingScannerJitterMs,
        salingScannerModelDelayMs,
        feeRate,
        buyMinDiscount,
        buyMinMargin,
        watchMinDiscount,
      });
      setParseDirty(false);
      await parseQuery.refetch();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h1>Настройки</h1>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Доступ</h2>
        <p style={{ color: 'var(--text-dim)', marginTop: 0 }}>
          Тот же пароль, что <code>ADMIN_TOKEN</code> на сервере. Без него чужой
          не откроет баланс, настройки и покупку. В адресной строке его нет.
        </p>
        <div className="form-row">
          <div className="form-field">
            <label>Пароль доступа</label>
            <input
              type="password"
              autoComplete="off"
              value={localAdminToken}
              onChange={(e) => setLocalAdminToken(e.target.value)}
            />
          </div>
          <button type="button" onClick={() => setAdminToken(localAdminToken)}>
            Запомнить в браузере
          </button>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Оценка лота</h2>
        <p style={{ color: 'var(--text-dim)', marginTop: 0 }}>
          Дней — для оценки в UI. Комиссия сохраняется на сервере (
          <code>parse-config.json</code>): saling-сканер, <code>/deals</code>,
          saling, все 4 среза. Комиссия по умолчанию <b>2%</b>.
        </p>
        <div className="form-row">
          <div className="form-field">
            <label>Дней по умолчанию</label>
            <input
              type="number"
              min={1}
              value={localDays}
              onChange={(e) => setLocalDays(e.target.value)}
            />
          </div>
          <div className="form-field">
            <label>Комиссия, %</label>
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={localFeePercent}
              onChange={(e) => {
                setParseDirty(true);
                setLocalFeePercent(e.target.value);
              }}
            />
          </div>
        </div>
        <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: '16px 0 8px' }}>
          Пороги <code>buy</code> / <code>watch</code> (доля от медианы и маржа после
          комиссии). Дефолт: buy 8% / 4%, watch 4%.
        </p>
        <div className="form-row">
          <div className="form-field">
            <label>Buy: дисконт к медиане, %</label>
            <input
              type="number"
              min={0}
              max={95}
              step={0.5}
              value={buyDiscountPct}
              onChange={(e) => {
                setParseDirty(true);
                setBuyDiscountPct(e.target.value);
              }}
            />
          </div>
          <div className="form-field">
            <label>Buy: маржа после комиссии, %</label>
            <input
              type="number"
              min={0}
              max={95}
              step={0.5}
              value={buyMarginPct}
              onChange={(e) => {
                setParseDirty(true);
                setBuyMarginPct(e.target.value);
              }}
            />
          </div>
          <div className="form-field">
            <label>Watch: дисконт к медиане, %</label>
            <input
              type="number"
              min={0}
              max={95}
              step={0.5}
              value={watchDiscountPct}
              onChange={(e) => {
                setParseDirty(true);
                setWatchDiscountPct(e.target.value);
              }}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Сканер лотов (saling)</h2>
        <label className="parse-config-item parse-config-item--toggle">
          <input
            type="checkbox"
            className="parse-config-checkbox"
            checked={salingScannerEnabled}
            onChange={(e) => {
              setParseDirty(true);
              setSalingScannerEnabled(e.target.checked);
            }}
          />
          <span className="parse-config-item__name">
            Опрашивать <code>POST /gifts/saling</code> и писать сигналы в{' '}
            <code>data/profit-deals.json</code> (buy) и{' '}
            <code>data/radar-deals.json</code> (watch)
          </span>
        </label>
        <div className="form-row" style={{ marginTop: 12 }}>
          <div className="form-field">
            <label>Пауза между опросами ленты, мс</label>
            <input
              type="number"
              min={200}
              max={60000}
              value={localSalingIntervalMs}
              onChange={(e) => {
                setParseDirty(true);
                setLocalSalingIntervalMs(e.target.value);
              }}
            />
          </div>
          <div className="form-field">
            <label>Разброс ±, мс (0 = ровно интервал)</label>
            <input
              type="number"
              min={0}
              max={30000}
              value={localSalingJitterMs}
              onChange={(e) => {
                setParseDirty(true);
                setLocalSalingJitterMs(e.target.value);
              }}
            />
          </div>
          <div className="form-field">
            <label>Пауза каталога/history при сканере, мс</label>
            <input
              type="number"
              min={50}
              max={60000}
              value={localSalingModelDelayMs}
              onChange={(e) => {
                setParseDirty(true);
                setLocalSalingModelDelayMs(e.target.value);
              }}
            />
          </div>
        </div>
        {parseQuery.data?.salingScannerEnvDefaults && (
          <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: '8px 0 0' }}>
            Дефолты из env на сервере: лента{' '}
            {parseQuery.data.salingScannerEnvDefaults.intervalMs} ±{' '}
            {parseQuery.data.salingScannerEnvDefaults.jitterMs} мс, history{' '}
            {parseQuery.data.salingScannerEnvDefaults.modelDelayMs} мс. Перезапуск не
            нужен.
          </p>
        )}
        <p style={{ color: 'var(--text-dim)', fontSize: 13, margin: '8px 0 0' }}>
          Запрос без фильтров, <code>ordering: None</code>,{' '}
          <code>count: 20</code> — <b>недавно выставленные</b> лоты. По каждому —
          4 среза. Обычный фон: коридор премии зависит от объёма 30д/7д, при полном
          сдвиге и ≥10 продажах модель+фон задаёт цену. Для Black и Onyx Black при ≥10 продажах
          коллекции с этим фоном вердикт идёт от фона, модель его не отменяет. На
          срезах при &lt;10 за 7д смотрим 30д. Свежий рынок модели (3д) отменяет buy
          коллекции. Если по продажам есть buy/watch — доп. запрос стакана{' '}
          <code>POST /gifts/saling</code> по коллекции+модели+фону. <code>buy</code> → profit-deals,{' '}
          <code>watch</code> → radar-deals. Только отмеченные коллекции. Смотри{' '}
          <Link to="/scanner">Сканер / радар</Link>.
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Скорость парсера</h2>
        <p style={{ color: 'var(--text-dim)', marginTop: 0 }}>
          Применяется между запросами каталога/history. Не действует, если
          включён сканер saling (там фиксированно 5 с). Перезапуск не нужен.
        </p>
        <div className="form-row">
          <div className="form-field">
            <label>Пауза между запросами, мс</label>
            <input
              type="number"
              min={50}
              max={60000}
              value={localDelayMs}
              onChange={(e) => {
                setParseDirty(true);
                setLocalDelayMs(e.target.value);
              }}
            />
          </div>
          <div className="form-field">
            <label>Страниц /feed на модель</label>
            <input
              type="number"
              min={1}
              max={50}
              value={localFeedPages}
              onChange={(e) => {
                setParseDirty(true);
                setLocalFeedPages(e.target.value);
              }}
            />
          </div>
          <div className="form-field">
            <label>Пауза между кругами истории, мс</label>
            <input
              type="number"
              min={0}
              max={3600000}
              value={localHistoryRoundMs}
              onChange={(e) => {
                setParseDirty(true);
                setLocalHistoryRoundMs(e.target.value);
              }}
            />
          </div>
        </div>
        {parseQuery.data?.parserEnvDefaults && (
          <p style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 0 }}>
            Дефолты из env на сервере: delay{' '}
            {parseQuery.data.parserEnvDefaults.delayMs}, pages{' '}
            {parseQuery.data.parserEnvDefaults.feedPages}, круг{' '}
            {parseQuery.data.parserEnvDefaults.historyRoundMs} мс.
          </p>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Парсинг коллекций</h2>
        <p style={{ color: 'var(--text-dim)', marginTop: 0 }}>
          При <code>npm run parse</code> запрашиваются только отмеченные
          коллекции (модели, фоны, история). Список из{' '}
          <code>catalog.json</code> — сначала хотя бы раз{' '}
          <code>parse -- --catalog</code>, чтобы появились имена.
        </p>

        <label className="parse-config-item parse-config-item--toggle">
          <input
            type="checkbox"
            className="parse-config-checkbox"
            checked={historyFetchBackdrops}
            onChange={(e) => {
              setParseDirty(true);
              setHistoryFetchBackdrops(e.target.checked);
            }}
          />
          <span className="parse-config-item__name">
            При <code>parse -- --history</code> доп. запросы /feed только для
            фонов:{' '}
            <b>
              {(parseQuery.data?.historyFeedBackdropNames ?? [
                'Black',
                'Onyx Black',
              ]).join(', ')}
            </b>
          </span>
        </label>

        {parseQuery.isLoading && <Loading />}
        {parseQuery.isError && <ErrorBox error={parseQuery.error} />}

        {parseQuery.data && collections.length === 0 && (
          <p style={{ color: 'var(--text-dim)' }}>В каталоге пока нет коллекций.</p>
        )}

        {collections.length > 0 && (
          <>
            <div className="parse-config-toolbar">
              <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
                Выбрано: {checked.size} / {collections.length}
              </span>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => selectAll(!allSelected)}
              >
                {allSelected ? 'Снять все' : 'Выбрать все'}
              </button>
            </div>
            <ul className="parse-config-list">
              {collections.map((name) => (
                <li key={name}>
                  <label className="parse-config-item">
                    <input
                      type="checkbox"
                      className="parse-config-checkbox"
                      checked={checked.has(name)}
                      onChange={() => toggleCollection(name)}
                    />
                    <StickerThumb
                      src={mrktStickerUrl(collectionThumbs[name])}
                      alt=""
                      size={40}
                    />
                    <span className="parse-config-item__name">{name}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {saveError && <ErrorBox error={new Error(saveError)} />}

      <button onClick={save} disabled={saving || parseQuery.isLoading}>
        {saving ? '...' : 'Сохранить'}
      </button>
      {saved && (
        <span style={{ marginLeft: 12, color: 'var(--green)' }}>
          сохранено
        </span>
      )}
    </div>
  );
}
