import { useId } from 'react';

interface Props {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}
export function Toggle({ label, description, checked, disabled = false, onChange }: Props) {
  const id = useId();
  return (
    <label className={`option-row ${disabled ? 'option-disabled' : ''}`} htmlFor={id}>
      <span>
        <span className="option-title">{label}</span>
        <span className="option-description">{description}</span>
      </span>
      <input
        id={id}
        className="toggle"
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}
