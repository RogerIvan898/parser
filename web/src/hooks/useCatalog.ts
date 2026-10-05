import { useQuery } from '@tanstack/react-query';
import { getCatalog } from '@/api/client';

export function useCatalog() {
  return useQuery({
    queryKey: ['catalog'],
    queryFn: getCatalog,
    staleTime: 5 * 60_000,
  });
}
