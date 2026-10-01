import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowDown, ArrowUp, History, Info, Play, RotateCcw, Square, Timer, Wrench, MessageSquareWarning, Sparkles } from 'lucide-react';
import { SPEED_TEST_FAILURE_MESSAGE, STATUS_COLORS, STATUS_LABELS, type HealthStatus, type LocationDTO, type FailureReason } from '@campus/shared';
import { api, ApiError } from '../../api/client';
import { useAppConfig, useLocations, useMaintenance, useTests } from '../../api/hooks';
import { LocationPicker } from '../../components/LocationPicker';
import { Badge, Button, Card, PageHeader, Segmented, StatusBadge, cx } from '../../components/ui';
import { fmtAgo, fmtDateTime, fmtMbps, fmtMs, fmtPct } from '../../lib/format';
import { Gauge, PHASE_COLOR } from './Gauge';
import { runSpeedTest, SpeedTestError, type Phase } from './engine/runner';
import { TARGETS, isLoopbackHost, type TargetId } from './engine/targets';

const LS_KEY = 'cw.lastLocation';
const LS_TARGET = 'cw.testTarget';
const readLS = () => {
  try {
    return localStorage.getItem(LS_KEY);
  } catch {
    return null;
  }
};
const writeLS = (v: string) => {
  try {
    localStorage.setItem(LS_KEY, v);
  } catch {
    /* storage unavailable */
  }
};

/** Failures that could not be reported because the server was unreachable; sent on the next success. */
const pendingFailures: Array<{ location_id: string; reason: FailureReason; detail: string }> = [];
async function flushFailures() {
  while (pendingFailures.length) {
    const f = pendingFailures[0]!;
    try {
      await api('/tests/failures', { method: 'POST', json: f });
      pendingFailures.shift();
    } catch {
      return;
    }
  }
}

export interface StoredResult {
  test_id: string;
  location_id: string;
  location_name: string;
  download_speed: number;
  upload_speed: number;
  ping: number;
  jitter: number;
  packet_loss: number;
  base_score: number;
  health_score: number;
  health_status: HealthStatus;
  tested_at: string;
  sub_scores: { download: number; upload: number; ping: number; loss: number };
  penalty: number;
  location_status: string;
  new_outage: { message: string } | null;
  new_insights: string[];
  target?: string | null;
}

export function SpeedTestPage() {
  const locs = useLocations();
  const cfg = useAppConfig();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [locationId, setLocationId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('location') ?? readLS());
  const [phase, setPhase] = useState<Phase>('idle');
  const [live, setLive] = useState<{ value: number | null; fraction: number }>({ value: null, fraction: 0 });
  const [partial, setPartial] = useState<{ ping?: number; download?: number; upload?: number }>({});
  const [pingSamples, setPingSamples] = useState<number[]>([]);
  const [result, setResult] = useState<StoredResult | null>(null);
  const [error, setError] = useState<{ message: string; detail: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const loopback = isLoopbackHost();
  const [targetId, setTargetId] = useState<TargetId>(() => {
    try {
      const v = localStorage.getItem(LS_TARGET);
      if (v === 'campus' || v === 'internet') return v;
    } catch {
      /* storage unavailable */
    }
    return loopback ? 'internet' : 'campus';
  });
  const chooseTarget = (t: TargetId) => {
    setTargetId(t);
    try {
      localStorage.setItem(LS_TARGET, t);
    } catch {
      /* storage unavailable */
    }
  };
  const quick = !!cfg.data?.speedtestQuick || new URLSearchParams(location.search).get('quick') === '1';

  const items = locs.data?.items ?? [];
  const loc = items.find((l) => l.location_id === locationId) ?? null;
  useEffect(() => {
    if (locs.data && locationId && !loc) setLocationId(null);
  }, [locs.data, locationId, loc]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const running = phase === 'ping' || phase === 'download' || phase === 'upload' || phase === 'saving';

  const start = async () => {
    if (!loc) return;
    setResult(null);
    setError(null);
    setPartial({});
    setPingSamples([]);
    setLive({ value: null, fraction: 0 });
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const raw = await runSpeedTest(
        {
          onPhase: (p) => {
            setPhase(p);
            setLive({ value: null, fraction: 0 });
          },
          onLive: (p, v, f) => {
            setLive({ value: v, fraction: f });
            if (p === 'ping') setPingSamples((s) => [...s, v]);
            else setPartial((x) => ({ ...x, [p]: v }));
          },
        },
        ac.signal,
        quick,
        TARGETS[targetId],
      );
      setPartial({ ping: raw.ping.pingMs, download: raw.downloadMbps, upload: raw.uploadMbps });
      setPhase('saving');
      const stored = await api<StoredResult>('/tests', {
        method: 'POST',
        json: {
          location_id: loc.location_id,
          download_mbps: raw.downloadMbps,
          upload_mbps: raw.uploadMbps,
          ping_ms: Math.max(0.1, raw.ping.pingMs),
          jitter_ms: raw.ping.jitterMs,
          packet_loss_pct: raw.ping.lossPct,
          client_meta: { target: targetId, quick, ua: navigator.userAgent.slice(0, 120), conn: (navigator as any).connection?.effectiveType },
        },
      });
      setResult({ ...stored, target: targetId });
      setPhase('done');
      void flushFailures();
      qc.invalidateQueries({ queryKey: ['tests'] });
      qc.invalidateQueries({ queryKey: ['locations'] });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setPhase('idle'); // user cancelled: discard silently
        return;
      }
      setPhase('error');
      if (e instanceof SpeedTestError) {
        setError({ message: SPEED_TEST_FAILURE_MESSAGE, detail: e.detail });
        const f = { location_id: loc.location_id, reason: e.reason, detail: e.detail.slice(0, 400) };
        api('/tests/failures', { method: 'POST', json: f }).catch(() => pendingFailures.push(f));
      } else if (e instanceof ApiError && e.status === 429) {
        setError({ message: e.message, detail: 'Your measurement was not stored. Try again in a few seconds.' });
      } else {
        setError({ message: SPEED_TEST_FAILURE_MESSAGE, detail: e instanceof Error ? e.message : 'Unknown error' });
      }
    } finally {
      abortRef.current = null;
    }
  };

  const unit = phase === 'ping' ? 'ms' : 'Mbps';

  return (
    <>
      <PageHeader
        title="Wi-Fi speed test"
        subtitle="Measures the connection between this device and the campus network, then turns it into a health score for the place you're sitting."
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className="card overflow-hidden">
          <div className="border-b border-line p-4 sm:p-5">
            <label className="label" htmlFor="loc-picker">Where are you?</label>
            <LocationPicker
              id="loc-picker"
              locations={items}
              value={locationId}
              onChange={(id) => {
                setLocationId(id);
                writeLS(id);
                if (!running) {
                  setResult(null);
                  setError(null);
                  setPhase('idle');
                }
              }}
            />
            {loc && <LocationAlerts loc={loc} />}
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="text-[13px] font-medium text-ink-2">Test against</span>
              <Segmented
                size="sm"
                label="Test against"
                value={targetId}
                onChange={(t) => !running && chooseTarget(t)}
                options={[
                  { value: 'campus', label: 'Campus network' },
                  { value: 'internet', label: 'Internet' },
                ]}
              />
              <span className="text-[12.5px] text-ink-3">
                {targetId === 'internet' ? 'Comparable with speedtest.net / fast.com' : 'Measures the Wi-Fi link to the campus server'}
              </span>
            </div>
            {loopback && targetId === 'campus' && (
              <div className="mt-3 flex items-start gap-2 rounded-lg bg-[#fff6dc] px-3 py-2 text-[13px] text-[#6b5200]" role="note">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  You opened the app on the same computer that runs the server, so a campus test only measures this computer talking to itself (thousands of Mbps).
                  Switch to <button className="font-medium underline" onClick={() => chooseTarget('internet')}>Internet</button>, or open the LAN address from a phone on the campus Wi-Fi.
                </span>
              </div>
            )}
          </div>

          <div className="px-4 pb-5 pt-3 sm:px-6">
            <Gauge phase={phase} value={phase === 'done' ? partial.download ?? null : live.value} unit={phase === 'done' ? 'Mbps download' : unit} fraction={live.fraction} pingSamples={pingSamples} />
            <PhaseSteps phase={phase} partial={partial} />
            <div className="mt-5 flex flex-col items-center gap-2">
              {running ? (
                <Button size="lg" variant="secondary" onClick={() => abortRef.current?.abort()} icon={<Square className="h-4 w-4" />} disabled={phase === 'saving'}>
                  Cancel test
                </Button>
              ) : (
                <Button size="lg" className="min-w-[220px]" onClick={start} disabled={!loc} icon={phase === 'done' || phase === 'error' ? <RotateCcw className="h-5 w-5" /> : <Play className="h-5 w-5" />}>
                  {phase === 'done' || phase === 'error' ? 'Run again' : 'Run speed test'}
                </Button>
              )}
              <p className="text-[12.5px] text-ink-3">
                {!loc ? 'Choose your location first.' : running ? 'Keep this page open until the test finishes.' : `Takes about ${quick ? 8 : 20} seconds.`}
              </p>
            </div>
          </div>
        </section>

        <div className="space-y-5">
          {error && <FailurePanel error={error} onRetry={start} />}
          {result ? (
            <ResultCard r={result} onReport={() => nav(`/complaints/new?location=${result.location_id}&test=${result.test_id}`)} />
          ) : (
            loc && <LocationSnapshot loc={loc} />
          )}
          <ScopeNote />
          <RecentMine />
        </div>
      </div>
    </>
  );
}

function PhaseSteps({ phase, partial }: { phase: Phase; partial: { ping?: number; download?: number; upload?: number } }) {
  const order: Phase[] = ['ping', 'download', 'upload'];
  const idx = order.indexOf(phase);
  const done = phase === 'saving' || phase === 'done';
  const steps = [
    { key: 'ping' as const, label: 'Ping', icon: <Timer className="h-4 w-4" />, value: partial.ping, unit: 'ms', fmt: fmtMs },
    { key: 'download' as const, label: 'Download', icon: <ArrowDown className="h-4 w-4" />, value: partial.download, unit: 'Mbps', fmt: fmtMbps },
    { key: 'upload' as const, label: 'Upload', icon: <ArrowUp className="h-4 w-4" />, value: partial.upload, unit: 'Mbps', fmt: fmtMbps },
  ];
  return (
    <ol className="mt-2 grid grid-cols-3 gap-2" aria-label="Test progress">
      {steps.map((s, i) => {
        const active = idx === i;
        const complete = done || idx > i;
        return (
          <li
            key={s.key}
            className={cx('rounded-xl border px-3 py-2.5 transition-colors', active ? 'border-transparent bg-paper' : 'border-line')}
            style={active ? { boxShadow: `inset 0 0 0 1.5px ${PHASE_COLOR[s.key]}` } : undefined}
            aria-current={active ? 'step' : undefined}
          >
            <div className="flex items-center gap-1.5 text-[12.5px] font-medium" style={{ color: active || complete ? PHASE_COLOR[s.key] : '#98a1b3' }}>
              {s.icon} {s.label}
            </div>
            <div className="mt-0.5 font-cond text-[22px] font-semibold leading-tight num">
              {s.value != null && (complete || active) ? s.fmt(s.value) : '–'}
              <span className="ml-1 font-sans text-[12px] font-normal text-ink-3">{s.unit}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function LocationAlerts({ loc }: { loc: LocationDTO }) {
  const maint = useMaintenance();
  const active = (maint.data?.items ?? []).filter((m) => m.is_active && (!m.location_id || m.location_id === loc.location_id));
  if (!loc.active_outage && !active.length) return null;
  return (
    <div className="mt-3 space-y-2">
      {loc.active_outage && (
        <div className="flex items-start gap-2 rounded-lg bg-[#fdeaea] px-3 py-2 text-[13.5px] text-st-critical" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Possible Wi-Fi outage detected in {loc.building}. IT support has been alerted. <Link to="/outages" className="font-medium underline">Details</Link>
          </span>
        </div>
      )}
      {active.map((m) => (
        <div key={m.maintenance_id} className="flex items-start gap-2 rounded-lg bg-[#fff6dc] px-3 py-2 text-[13.5px] text-[#6b5200]">
          <Wrench className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Maintenance in progress: {m.title}. Results may be lower than usual until {fmtDateTime(m.ends_at)}.</span>
        </div>
      ))}
    </div>
  );
}

function FailurePanel({ error, onRetry }: { error: { message: string; detail: string }; onRetry: () => void }) {
  return (
    <div className="card border-[#f3b7b7] p-5" role="alert">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#fdeaea] text-st-critical">
          <AlertTriangle className="h-5 w-5" />
        </span>
        <div className="flex-1">
          <p className="font-semibold text-[#7f1515]">{error.message}</p>
          <p className="mt-1 text-sm text-ink-3">{error.detail}</p>
          <p className="mt-1 text-[12.5px] text-ink-4">No result was stored, so the dashboard is not affected by an incomplete measurement.</p>
          <Button className="mt-3" size="sm" variant="secondary" onClick={onRetry} icon={<RotateCcw className="h-4 w-4" />}>Try again</Button>
        </div>
      </div>
    </div>
  );
}

function ScoreRing({ score, status }: { score: number; status: HealthStatus }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const color = STATUS_COLORS[status];
  return (
    <svg viewBox="0 0 120 120" className="h-[118px] w-[118px] shrink-0" role="img" aria-label={`Health score ${Math.round(score)} out of 100, ${STATUS_LABELS[status]}`}>
      <circle cx="60" cy="60" r={r} stroke="#e3e8ef" strokeWidth="10" fill="none" />
      <circle cx="60" cy="60" r={r} stroke={color} strokeWidth="10" fill="none" strokeLinecap="round" strokeDasharray={`${(score / 100) * c} ${c}`} transform="rotate(-90 60 60)" style={{ transition: 'stroke-dasharray .8s ease-out' }} />
      <text x="60" y="62" textAnchor="middle" fontFamily='"IBM Plex Sans Condensed"' fontWeight="700" fontSize="34" fill="#14223b">{Math.round(score)}</text>
      <text x="60" y="80" textAnchor="middle" fontSize="11" fill="#66728a">/ 100</text>
    </svg>
  );
}

export function ResultCard({ r, onReport }: { r: StoredResult; onReport?: () => void }) {
  const [why, setWhy] = useState(false);
  const sub = r.sub_scores;
  const parts = [
    { k: 'Download', v: sub.download, w: 0.3, color: '#2a78d6' },
    { k: 'Upload', v: sub.upload, w: 0.15, color: '#eb6834' },
    { k: 'Ping', v: sub.ping, w: 0.3, color: '#1baf7a' },
    { k: 'Packet loss', v: sub.loss, w: 0.25, color: '#4a3aa7' },
  ];
  return (
    <section className="card animate-rise overflow-hidden" aria-live="polite">
      <div className="flex items-center gap-4 border-b border-line p-5">
        <ScoreRing score={r.health_score} status={r.health_status} />
        <div className="min-w-0">
          <p className="text-[13px] text-ink-3">Network health at {r.location_name}</p>
          <p className="font-cond text-[32px] font-semibold leading-tight" style={{ color: r.health_status === 'fair' ? '#8a6a00' : STATUS_COLORS[r.health_status] }}>
            {STATUS_LABELS[r.health_status]}
          </p>
          <p className="text-[13px] text-ink-3">
            Tested {fmtDateTime(r.tested_at)} · against {r.target === 'internet' ? 'the internet (Cloudflare)' : 'the campus server'}
          </p>
          {r.target === 'internet' && (
            <p className="mt-1 text-[12.5px] text-ink-3">
              Compare on{' '}
              <a className="text-accent hover:underline" href="https://www.speedtest.net" target="_blank" rel="noreferrer">speedtest.net</a>,{' '}
              <a className="text-accent hover:underline" href="https://fast.com" target="_blank" rel="noreferrer">fast.com</a> or{' '}
              <a className="text-accent hover:underline" href="https://speed.cloudflare.com" target="_blank" rel="noreferrer">speed.cloudflare.com</a>
            </p>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3">
        {[
          ['Download', fmtMbps(r.download_speed), 'Mbps'],
          ['Upload', fmtMbps(r.upload_speed), 'Mbps'],
          ['Ping', fmtMs(r.ping), 'ms'],
          ['Jitter', fmtMs(r.jitter), 'ms'],
          ['Packet loss', fmtPct(r.packet_loss), ''],
          ['Health score', `${Math.round(r.health_score)}`, '/ 100'],
        ].map(([k, v, u]) => (
          <div key={k} className="bg-white px-4 py-3">
            <dt className="text-[12.5px] text-ink-3">{k}</dt>
            <dd className="font-cond text-[24px] font-semibold leading-tight num">
              {v}
              {u && <span className="ml-1 font-sans text-[12px] font-normal text-ink-3">{u}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <div className="border-t border-line px-5 py-3">
        <button className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent" onClick={() => setWhy((w) => !w)} aria-expanded={why}>
          <Info className="h-4 w-4" /> {why ? 'Hide' : 'How was this score calculated?'}
        </button>
        {why && (
          <div className="mt-3 space-y-2">
            {parts.map((p) => (
              <div key={p.k} className="grid grid-cols-[92px_1fr_88px] items-center gap-2 text-[13px]">
                <span className="text-ink-2">{p.k}</span>
                <span className="h-2 overflow-hidden rounded-full bg-paper">
                  <span className="block h-full rounded-full" style={{ width: `${p.v}%`, background: p.color }} />
                </span>
                <span className="num text-right text-ink-3">{Math.round(p.v)} × {Math.round(p.w * 100)}%</span>
              </div>
            ))}
            <p className="text-[12.5px] text-ink-3">
              Weighted base score {r.base_score.toFixed(1)}
              {r.penalty > 0 ? ` − ${r.penalty} for recent failures and open complaints here` : ''} = <b className="text-ink">{r.health_score.toFixed(1)}</b>.
            </p>
          </div>
        )}
      </div>
      {(r.new_outage || r.new_insights?.length > 0) && (
        <div className="space-y-1.5 border-t border-line bg-paper/60 px-5 py-3 text-[13px]">
          {r.new_outage && <p className="flex items-center gap-2 font-medium text-st-critical"><AlertTriangle className="h-4 w-4" /> {r.new_outage.message}</p>}
          {r.new_insights?.map((m) => (
            <p key={m} className="flex items-start gap-2 text-ink-2"><Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" /> {m}</p>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2 border-t border-line p-4">
        {onReport && (
          <Button variant={r.health_status === 'poor' || r.health_status === 'critical' ? 'primary' : 'secondary'} onClick={onReport} icon={<MessageSquareWarning className="h-4 w-4" />}>
            Report a problem
          </Button>
        )}
        <Link to="/history">
          <Button variant="ghost" icon={<History className="h-4 w-4" />}>View history</Button>
        </Link>
      </div>
    </section>
  );
}

function LocationSnapshot({ loc }: { loc: LocationDTO }) {
  return (
    <Card title={loc.location_name} subtitle={`${loc.building}${loc.floor != null ? ` · Floor ${loc.floor}` : ''}`} actions={<StatusBadge status={loc.current_status} score={loc.current_score} stale={!!loc.current_stale} />}>
      <div className="grid grid-cols-3 gap-3 text-center">
        {[
          ['Avg download today', fmtMbps(loc.today.avg_download), 'Mbps'],
          ['Avg ping today', fmtMs(loc.today.avg_ping), 'ms'],
          ['Tests today', String(loc.today.tests), ''],
        ].map(([k, v, u]) => (
          <div key={k} className="rounded-lg bg-paper/70 px-2 py-3">
            <div className="font-cond text-[22px] font-semibold num">{v}<span className="ml-1 font-sans text-[11px] font-normal text-ink-3">{u}</span></div>
            <div className="text-[12px] text-ink-3">{k}</div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[13px] text-ink-3">
        Last tested {fmtAgo(loc.last_tested_at)} · {loc.today.complaints} complaint{loc.today.complaints === 1 ? '' : 's'} today.{' '}
        <Link to="/status" className="text-accent hover:underline">Compare with other locations</Link>
      </p>
    </Card>
  );
}

function ScopeNote() {
  return (
    <p className="flex gap-2 rounded-lg bg-white/60 px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-3">
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        <b className="font-medium text-ink-2">Campus network</b> measures the path between this device and the campus server (Wi-Fi link + LAN), which isolates Wi-Fi quality; run the server on a wired machine. A phone on weak Wi-Fi will correctly score badly.{' '}
        <b className="font-medium text-ink-2">Internet</b> measures against Cloudflare's public speed-test servers, so results are comparable with speedtest.net. Results from different services differ by roughly 10–20% because they use different servers and methods.
      </span>
    </p>
  );
}

function RecentMine() {
  const q = useTests({ pageSize: 5 });
  const rows = useMemo(() => q.data?.items ?? [], [q.data]);
  if (!rows.length) return null;
  return (
    <Card title="Your recent tests" actions={<Link to="/history" className="text-[13px] font-medium text-accent hover:underline">All history</Link>} pad={false}>
      <ul>
        {rows.map((t) => (
          <li key={t.test_id} className="flex items-center gap-3 border-b border-line/70 px-4 py-2.5 text-[13.5px] last:border-0">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{t.location_name}</span>
              <span className="text-[12px] text-ink-3">{fmtAgo(t.tested_at)}</span>
            </span>
            <span className="num text-ink-2">{fmtMbps(t.download_speed)} <span className="text-ink-4">Mbps</span></span>
            <span className="num w-14 text-right text-ink-2">{fmtMs(t.ping)} <span className="text-ink-4">ms</span></span>
            <StatusBadge status={t.health_status} size="sm" />
            {t.target === 'internet' && <Badge tone="accent">Internet</Badge>}
          </li>
        ))}
      </ul>
      {rows.some((t) => t.during_maintenance) && <div className="px-4 pb-3"><Badge tone="warn">Some results were taken during maintenance</Badge></div>}
    </Card>
  );
}
