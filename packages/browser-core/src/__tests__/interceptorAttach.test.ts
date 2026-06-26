import { RequestInterceptor } from '../interceptor';
import { MaintenanceProbe } from '../maintenanceProbe';

describe('RequestInterceptor.attachByConfig + hotReloadRules', () => {
  beforeEach(() => MaintenanceProbe.reset());

  it('attachByConfig registers patterns and sets validation configs', async () => {
    MaintenanceProbe.setEnabled(true);
    const pushed: any[] = [];
    MaintenanceProbe.setRedisPusher(async (_c, p) => { pushed.push(JSON.parse(p)); });
    MaintenanceProbe.enterStep('monitor', 'douyin', 'p', 's', undefined, 'e1');

    const interceptor = new RequestInterceptor();
    const registered: string[] = [];
    const validated: any[] = [];
    (interceptor as any).register = async (_page: any, pats: string[]) => { registered.push(...pats); return 'pid'; };
    (interceptor as any).setValidationConfig = (pat: string, cfg: any) => { validated.push({ pat, cfg }); };

    const config = {
      video_list: {
        url_patterns: ['/aweme/v1/web/aweme/post', '/aweme/v2/web/aweme/post'],
        method: 'POST',
        validation: { required_body_fields: ['data.aweme_list'] },
      },
    };
    await interceptor.attachByConfig({} as any, 'douyin', ['video_list'], config);
    MaintenanceProbe.exitStep();
    await MaintenanceProbe.flush();

    expect(registered).toContain('/aweme/v1/web/aweme/post');
    expect(validated).toHaveLength(2);
    expect(validated[0].cfg.requiredBodyFields).toContain('data.aweme_list');
  });

  it('hotReloadRules replaces validation configs without re-registering', () => {
    const interceptor = new RequestInterceptor();
    const calls: any[] = [];
    (interceptor as any).setValidationConfig = (pat: string, cfg: any) => calls.push({ pat, cfg });
    (interceptor as any).register = async () => 'pid';

    interceptor.hotReloadRules({
      video_list: { url_patterns: ['/new'], validation: { required_body_fields: ['x'] } },
    });
    expect(calls.some(c => c.pat === '/new')).toBe(true);
  });
});
