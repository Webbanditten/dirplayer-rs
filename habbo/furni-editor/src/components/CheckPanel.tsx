import { Icon } from './Icon';
import type { Fix, Issue } from '../check';

const FIX_LABEL: Record<Fix, string> = {
  icon: 'Make icon',
  small: 'Make 32 px',
  rename: 'New from this…',
  shadow: 'Make shadow',
};

interface Props {
  issues: Issue[];
  onPick: (issue: Issue) => void;
  onFix: (issue: Issue) => void;
  onClose: () => void;
}

/** The "Check furni" list: errors first; a row with a member selects it, a row with a fix offers it. */
export function CheckPanel({ issues, onPick, onFix, onClose }: Props) {
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.filter((i) => i.level === 'warning').length;
  return (
    <div className="popover check-panel" role="dialog" aria-label="Check furni">
      <div className="check-head">
        <h4>Check furni</h4>
        <span className="muted small">
          {errors || warnings ? `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}` : 'Ready for the hotel'}
        </span>
        <span className="spacer" />
        <button className="icon ghost" onClick={onClose} title="Close"><Icon name="close" /></button>
      </div>
      {issues.length === 0 ? (
        <p className="check-ok"><Icon name="check" size={18} />Nothing found: names, fields, aliases, palettes, layers, frames, the icon and the 32 px cast look right.</p>
      ) : (
        <ul className="check-list">
          {issues.map((i, k) => (
            <li key={k} className={`check-item ${i.level}`}>
              <span className={`lvl ${i.level}`}>{i.level === 'error' ? 'Error' : i.level === 'warning' ? 'Warning' : 'Note'}</span>
              <span className="side">{i.side === 'small' ? '32 px' : '64 px'}</span>
              <span className="text">{i.text}</span>
              <span className="acts">
                {i.slot !== undefined && <button className="ghost" onClick={() => onPick(i)}>Show</button>}
                {i.fix && <button onClick={() => onFix(i)}>{FIX_LABEL[i.fix]}</button>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small check-foot">Housekeeping refuses a cast with errors. Warnings and notes show where the hotel will draw it differently than you may expect.</p>
    </div>
  );
}
