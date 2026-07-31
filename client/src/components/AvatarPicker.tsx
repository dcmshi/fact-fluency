import { useTranslation } from 'react-i18next';
import { AVATARS } from '../ops';
import './AvatarPicker.css';

/**
 * The buddy (avatar emoji) picker — shared by Add-a-kid and Settings.
 *
 * `labelledBy` should be the id of the visible heading for the picker. The
 * twelve buttons are one choice, and without a labelled group around them a
 * screen reader reads twelve unrelated buttons with no idea what they are for.
 */
export function AvatarPicker({
  value,
  onChange,
  labelledBy,
}: {
  value: string;
  onChange: (avatar: string) => void;
  labelledBy?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="avatar-picker" role="group" aria-labelledby={labelledBy}>
      {AVATARS.map((a) => (
        <button
          key={a}
          className={`avatar-option ${a === value ? 'selected' : ''}`}
          onClick={() => onChange(a)}
          aria-pressed={a === value}
          aria-label={t('modals.buddyOption', { avatar: a })}
        >
          {a}
        </button>
      ))}
    </div>
  );
}
