import os
import re
from collections import defaultdict

BACKEND_DIR = "/home/whatsapp/app"
FRONTEND_DIR = "/home/whatsapp/app/frontend/src"

def get_backend_routes():
    routes = set()
    router_prefixes = {}
    
    # Find prefixes
    for root, _, files in os.walk(BACKEND_DIR):
        if 'frontend' in root or 'node_modules' in root or 'venv' in root or '__pycache__' in root or '.git' in root:
            continue
        for file in files:
            if file.endswith('.py'):
                path = os.path.join(root, file)
                with open(path, 'r', encoding='utf-8') as f:
                    content = f.read()
                    for match in re.finditer(r'([a-zA-Z0-9_]+)\s*=\s*APIRouter\([^)]*prefix=[\'"]([^\'"]+)[\'"]', content):
                        router_prefixes[match.group(1)] = match.group(2)
                        
    # app.py include_router prefixes
    with open(os.path.join(BACKEND_DIR, 'app.py'), 'r', encoding='utf-8') as f:
        content = f.read()
        for match in re.finditer(r'app\.include_router\(\s*([a-zA-Z0-9_]+)[^)]*prefix=[\'"]([^\'"]+)[\'"]', content):
            router_prefixes[match.group(1)] = match.group(2)

    regex = re.compile(r'@(?:app|bp|blueprint|([a-zA-Z0-9_]+router[a-zA-Z0-9_]*)|(router[a-zA-Z0-9_]*))\.(route|get|post|put|delete|patch)\([\'"]([^\'"]+)[\'"]')
    for root, _, files in os.walk(BACKEND_DIR):
        if 'frontend' in root or 'node_modules' in root or 'venv' in root or '__pycache__' in root or '.git' in root:
            continue
        for file in files:
            if file.endswith('.py'):
                path = os.path.join(root, file)
                with open(path, 'r', encoding='utf-8') as f:
                    for line in f:
                        match = regex.search(line)
                        if match:
                            router1 = match.group(1)
                            router2 = match.group(2)
                            router = router1 or router2 or "app"
                            method = match.group(3).upper()
                            if method == 'ROUTE':
                                method = 'ANY'
                            route = match.group(4)
                            
                            prefix = router_prefixes.get(router, "")
                            
                            if prefix:
                                full_route = prefix + route
                            else:
                                if route.startswith('/api'):
                                    full_route = route
                                else:
                                    if route.startswith('/'):
                                        full_route = '/api' + route
                                    else:
                                        full_route = '/api/' + route
                            
                            full_route = full_route.replace('//', '/')
                            routes.add(f"{method} {full_route}")
    return routes

def get_frontend_calls():
    calls = set()
    regex = re.compile(r'(?:api|axios|fetch)\.(?:get|post|put|delete|patch)?\([\'"`]([^\'"`\?\$]+)')
    fetch_regex = re.compile(r'fetch\([\'"`]([^\'"`\?\$]+)')
    _b_regex = re.compile(r'_b\([\'"`]([^\'"`\?\$]+)')
    
    # Also find string templates that end before a variable, eg `/api/accounts/${id}` => `/api/accounts/`
    template_regex = re.compile(r'(?:api|axios|fetch)\.(?:get|post|put|delete|patch)?\([\'"`]([^\'"`\?\$]*)\$\{')
    fetch_template_regex = re.compile(r'fetch\([\'"`]([^\'"`\?\$]*)\$\{')
    _b_template_regex = re.compile(r'_b\([\'"`]([^\'"`\?\$]*)\$\{')

    for root, _, files in os.walk(FRONTEND_DIR):
        for file in files:
            if file.endswith(('.js', '.jsx', '.ts', '.tsx')):
                path = os.path.join(root, file)
                with open(path, 'r', encoding='utf-8') as f:
                    content = f.read()
                    
                    for match in regex.finditer(content):
                        url = match.group(1)
                        if url.startswith('/api'):
                            calls.add(url)
                    
                    for match in fetch_regex.finditer(content):
                        url = match.group(1)
                        if url.startswith('/api'):
                            calls.add(url)
                            
                    for match in _b_regex.finditer(content):
                        url = match.group(1)
                        if url.startswith('/api'):
                            calls.add(url)

                    for match in template_regex.finditer(content):
                        url = match.group(1)
                        if url.startswith('/api'):
                            calls.add(url + "{id}")
                    for match in fetch_template_regex.finditer(content):
                        url = match.group(1)
                        if url.startswith('/api'):
                            calls.add(url + "{id}")
                    for match in _b_template_regex.finditer(content):
                        url = match.group(1)
                        if url.startswith('/api'):
                            calls.add(url + "{id}")
                            
    return calls

if __name__ == '__main__':
    backend_routes = get_backend_routes()
    frontend_calls = get_frontend_calls()

    print("=== BACKEND ROUTES ===")
    for r in sorted(backend_routes):
        print(r)
        
    print("\n=== FRONTEND API CALLS ===")
    for c in sorted(frontend_calls):
        print(c)
