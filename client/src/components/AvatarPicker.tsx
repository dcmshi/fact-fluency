import { AVATARS } from '../ops';
import './AvatarPicker.css';

/** The buddy (avatar emoji) picker — shared by Add-a-kid and Settings. */
export function AvatarPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (avatar: string) => void;
}) {
  return (
    <div className="avatar-picker">
      {AVATARS.map((a) => (
        <button
          key={a}
          className={`avatar-option ${a === value ? 'selected' : ''}`}
          onClick={() => onChange(a)}
          aria-pressed={a === value}
          aria-label={`Buddy ${a}`}
        >
          {a}
        </button>
      ))}
    </div>
  );
}
