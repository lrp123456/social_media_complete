import { MaterialIcon } from '@/components/ui/MaterialIcon';

export function QueryError({ message = '加载失败，请刷新重试' }: { message?: string }) {
  return (
    <div className="p-inner-component-padding text-center text-error">
      <MaterialIcon icon="error" size="xl" className="mb-2" />
      <p className="text-body-sm">{message}</p>
    </div>
  );
}
