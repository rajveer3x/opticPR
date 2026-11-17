import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent,
} from 'react';
import { useLocation } from 'react-router-dom';
import {
  ArrowUpRight,
  Code2,
  GitBranch,
  Pause,
  Play,
  ScanLine,
} from 'lucide-react';

const MotionContext = createContext({
  enabled: false,
  reduced: false,
  toggle: () => {},
});
const preferenceKey = 'opticpr-motion';
export function MotionProvider({ children }: { children: ReactNode }) {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [paused, setPaused] = useState(() => {
    try {
      return localStorage.getItem(preferenceKey) === 'paused';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const enabled = !reduced && !paused;
  useEffect(() => {
    document.documentElement.dataset.motion = enabled ? 'on' : 'off';
  }, [enabled]);
  function toggle() {
    setPaused((value) => {
      try {
        localStorage.setItem(preferenceKey, value ? 'playing' : 'paused');
      } catch {
        /* Motion still works without storage. */
      }
      return !value;
    });
  }
  return (
    <MotionContext.Provider value={{ enabled, reduced, toggle }}>
      {children}
    </MotionContext.Provider>
  );
}
export function MotionToggle() {
  const { enabled, reduced, toggle } = useContext(MotionContext);
  return (
    <button
      className="motion-toggle"
      onClick={toggle}
      disabled={reduced}
      title={
        reduced
          ? 'Animations follow your system’s reduced-motion preference'
          : undefined
      }
      aria-label={
        reduced
          ? 'Animations disabled by system preference'
          : enabled
            ? 'Pause animations'
            : 'Enable animations'
      }
      aria-pressed={enabled}
    >
      <span className="motion-bars" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      {enabled ? <Pause size={12} /> : <Play size={12} />}
      <span>Motion {enabled ? 'on' : 'off'}</span>
    </button>
  );
}
export function PageMotion({
  children,
  fullBleed = false,
}: {
  children: ReactNode;
  fullBleed?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    const container = root.current;
    if (!container || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.setAttribute('data-visible', 'true');
            observer.unobserve(entry.target);
          }
        }),
      { threshold: 0.08 },
    );
    const register = () =>
      container
        .querySelectorAll('[data-reveal]:not([data-visible])')
        .forEach((element) => observer.observe(element));
    register();
    const changes = new MutationObserver(register);
    changes.observe(container, { childList: true, subtree: true });
    return () => {
      changes.disconnect();
      observer.disconnect();
    };
  }, [pathname]);
  return (
    <div
      className={`page-transition ${fullBleed ? 'auth-transition' : ''}`}
      ref={root}
      key={pathname}
    >
      {children}
    </div>
  );
}
export function useCardTilt() {
  const { enabled } = useContext(MotionContext);
  function move(event: PointerEvent<HTMLElement>) {
    if (!enabled || event.pointerType !== 'mouse') return;
    const target = event.currentTarget,
      box = target.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width,
      y = (event.clientY - box.top) / box.height;
    target.style.setProperty('--tilt-x', `${(0.5 - y) * 5}deg`);
    target.style.setProperty('--tilt-y', `${(x - 0.5) * 5}deg`);
    target.style.setProperty('--light-x', `${x * 100}%`);
    target.style.setProperty('--light-y', `${y * 100}%`);
  }
  function reset(event: PointerEvent<HTMLElement>) {
    const target = event.currentTarget;
    target.style.setProperty('--tilt-x', '0deg');
    target.style.setProperty('--tilt-y', '0deg');
  }
  return { onPointerMove: move, onPointerLeave: reset };
}
export function SignalScene({ compact = false }: { compact?: boolean }) {
  const id = useId().replaceAll(':', '');
  const scene = useRef<HTMLDivElement>(null);
  const { enabled } = useContext(MotionContext);
  useEffect(() => {
    const element = scene.current;
    if (!element || !enabled) return;
    let frame = 0;
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = element.getBoundingClientRect();
        element.style.setProperty(
          '--scene-x',
          `${((event.clientX - box.left) / box.width - 0.5) * 15}px`,
        );
        element.style.setProperty(
          '--scene-y',
          `${((event.clientY - box.top) / box.height - 0.5) * 12}px`,
        );
      });
    };
    element.addEventListener('pointermove', move);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('pointermove', move);
      element.style.setProperty('--scene-x', '0px');
      element.style.setProperty('--scene-y', '0px');
    };
  }, [enabled]);
  return (
    <div
      ref={scene}
      className={`signal-scene ${compact ? 'compact' : ''}`}
      aria-hidden="true"
    >
      <div className="scene-grid" />
      <div className="scene-glow" />
      <svg className="starfield" viewBox="0 0 700 600">
        <g fill="#fff">
          {Array.from({ length: 62 }, (_, i) => (
            <circle
              key={i}
              cx={(i * 173 + 31) % 700}
              cy={(i * 97 + 17) % 600}
              r={i % 7 === 0 ? 1.2 : 0.65}
              opacity={0.1 + (i % 5) * 0.065}
            />
          ))}
        </g>
      </svg>
      <div className="orbit-system">
        <svg className="orbit-object" viewBox="0 0 600 600" fill="none">
          <defs>
            <linearGradient
              id={`${id}-chrome`}
              x1="100"
              y1="80"
              x2="470"
              y2="520"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#101112" />
              <stop offset=".17" stopColor="#f4f3ef" />
              <stop offset=".25" stopColor="#52565b" />
              <stop offset=".39" stopColor="#101112" />
              <stop offset=".55" stopColor="#b6babd" />
              <stop offset=".66" stopColor="#f5f6f7" />
              <stop offset=".73" stopColor="#35383b" />
              <stop offset=".9" stopColor="#0b0c0d" />
              <stop offset="1" stopColor="#767a7c" />
            </linearGradient>
            <linearGradient
              id={`${id}-edge`}
              x1="60"
              y1="100"
              x2="500"
              y2="510"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#fff" />
              <stop offset=".23" stopColor="#454647" />
              <stop offset=".5" stopColor="#111213" />
              <stop offset=".75" stopColor="#d0d2d3" />
              <stop offset="1" stopColor="#55585a" />
            </linearGradient>
            <linearGradient
              id={`${id}-heat`}
              x1="360"
              y1="150"
              x2="500"
              y2="420"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#ffb676" />
              <stop offset=".3" stopColor="#ff602e" />
              <stop offset="1" stopColor="#64230e" />
            </linearGradient>
            <radialGradient id={`${id}-core`}>
              <stop stopColor="#fce7c6" />
              <stop offset=".35" stopColor="#ff7b42" />
              <stop offset=".72" stopColor="#ff5724" />
              <stop offset="1" stopColor="#651d0c" />
            </radialGradient>
          </defs>
          <g className="chrome-body" transform="rotate(-31 300 300)">
            <ellipse
              cx="300"
              cy="300"
              rx="209"
              ry="161"
              stroke={`url(#${id}-edge)`}
              strokeWidth="2"
            />
            <ellipse
              cx="300"
              cy="300"
              rx="184"
              ry="137"
              stroke={`url(#${id}-chrome)`}
              strokeWidth="44"
            />
            <ellipse
              cx="300"
              cy="300"
              rx="162"
              ry="115"
              stroke={`url(#${id}-edge)`}
              strokeWidth="2"
            />
            <ellipse
              cx="300"
              cy="300"
              rx="217"
              ry="170"
              stroke="#4c4c49"
              strokeWidth=".5"
              strokeDasharray="2 12"
            />
            <path
              d="M 442 213 A 184 137 0 0 1 453 376"
              stroke={`url(#${id}-heat)`}
              strokeWidth="44"
            />
            <ellipse
              cx="300"
              cy="300"
              rx="105"
              ry="206"
              stroke={`url(#${id}-chrome)`}
              strokeWidth="31"
              transform="rotate(51 300 300)"
            />
            <ellipse
              cx="300"
              cy="300"
              rx="121"
              ry="222"
              stroke={`url(#${id}-edge)`}
              strokeWidth="1"
              transform="rotate(51 300 300)"
            />
            <ellipse
              cx="300"
              cy="300"
              rx="88"
              ry="190"
              stroke="#8e9295"
              strokeWidth=".7"
              transform="rotate(51 300 300)"
            />
            <circle cx="300" cy="300" r="42" fill={`url(#${id}-core)`} />
            <circle
              cx="300"
              cy="300"
              r="54"
              stroke="#ff7645"
              strokeOpacity=".22"
            />
            <path
              d="M 289 299 L 297 307 L 313 289"
              stroke="#33150d"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        </svg>
        <span className="orbit-cross one">+</span>
        <span className="orbit-cross two">+</span>
      </div>
      <div className="floating-panel panel-source">
        <span className="panel-label">
          <Code2 size={12} />
          01 / SOURCE
        </span>
        <div className="mini-code">
          <i />
          <i />
          <i />
          <i />
        </div>
        <span className="panel-bottom">
          A claim. An exact line.
          <ArrowUpRight size={13} />
        </span>
      </div>
      <div className="floating-panel panel-revision">
        <span className="panel-label">
          <GitBranch size={12} />
          02 / REVISION
        </span>
        <div className="mini-revisions">
          <span>BASE</span>
          <b>→</b>
          <span>HEAD</span>
        </div>
        <span className="panel-bottom">Every commit accounted for.</span>
      </div>
      <div className="floating-panel panel-signal">
        <ScanLine size={18} />
        <div>
          <span className="panel-label">03 / EVIDENCE</span>
          <strong>Signal over noise.</strong>
        </div>
        <span className="signal-pulse" />
      </div>
      <span className="scene-coordinate top">OPTIC / ENGINE</span>
      <span className="scene-coordinate bottom">SOURCE → SIGNAL → CLARITY</span>
    </div>
  );
}
export function SignalMarquee() {
  return (
    <div className="signal-marquee" aria-hidden="true">
      <div>
        {[0, 1, 2, 3].map((i) => (
          <span key={i}>
            LESS NOISE.<b>✳</b>MORE SIGNAL.<b>✳</b>EVERY REVISION.<b>✳</b>
          </span>
        ))}
      </div>
    </div>
  );
}
