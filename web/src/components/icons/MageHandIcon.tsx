import { Icon } from '@iconify/react';
import handBones from '@iconify-icons/material-symbols/hand-bones';
import type { ComponentProps } from 'react';

export const MageHandIcon = (props: Omit<ComponentProps<typeof Icon>, 'icon'>) => (
  <Icon icon={handBones} aria-hidden="true" {...props} />
);
