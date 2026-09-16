import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { HostBrowserProfileButton } from './host-browser-profile-button';
const profileId = '11111111-1111-4111-8111-111111111111', temporaryId = '22222222-2222-4222-8222-222222222222';
const page = { pageId: temporaryId, profileId: temporaryId, temporary:true, profileLocked:false, title:'',url:'about:blank',available:true };
const browserRequest=vi.fn(async()=>({profiles:[{profileId,name:'Work',revision:0},{profileId:temporaryId,name:'Temporary',revision:0,temporary:true}]}));
it('offers named Profiles without exposing temporary storage identities',async()=>{
  const user=userEvent.setup(),select=vi.fn(async()=>{});
  render(<HostBrowserProfileButton client={{browserRequest} as any} page={page} select={select} />);
  await user.click(screen.getByRole('button',{name:'Profiles'}));
  await waitFor(()=>expect(screen.getByRole('menuitem',{name:'Work'})).toBeInTheDocument());
  expect(screen.queryByRole('menuitem',{name:'Temporary'})).not.toBeInTheDocument();
  expect(screen.queryByRole('menuitem',{name:/No Profile/})).not.toBeInTheDocument();
  await user.click(screen.getByRole('menuitem',{name:'Work'}));
  expect(select).toHaveBeenCalledExactlyOnceWith(profileId);
});
it('shows the selected Profile while preventing changes after a named page has loaded',async()=>{
  const user=userEvent.setup(),select=vi.fn();
  render(<HostBrowserProfileButton client={{browserRequest} as any} page={{...page,profileId,temporary:false,profileLocked:true,url:'https://example.com/'}} select={select} />);
  await waitFor(()=>expect(screen.getByRole('button',{name:'Profiles'})).toHaveAttribute('title','Work — locked for this Pane'));
  await user.click(screen.getByRole('button',{name:'Profiles'}));
  expect(screen.queryByText('Profile locked for this Pane')).not.toBeInTheDocument();
  expect(screen.getByRole('menuitem',{name:'Work ✓'})).toHaveAttribute('aria-disabled','true');
  expect(select).not.toHaveBeenCalled();
});
