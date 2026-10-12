import {Link} from '@tanstack/react-router';
import {useLocale} from '../lib/locale';

export function RouteNotFound() {
    const {locale} = useLocale(), ko = locale === 'ko';
    return <main className="route-error"><div className="wrap">
        <h1>{ko ? '페이지를 찾을 수 없어요.' : 'Page not found.'}</h1>
        <p>{ko ? '주소를 확인하거나 홈에서 다시 시작해 주세요.' : 'Check the address, or start again from home.'}</p>
        <Link className="route-error-action" to={ko ? '/ko' : '/'}>{ko ? '홈으로 돌아가기' : 'Back to home'}</Link>
    </div></main>;
}
