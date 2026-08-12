#!/usr/bin/env python3
import yaml
from pathlib import Path

SHARED_FILE = "shared.yml"
SPECS_DIR = "."

def load_yaml(path):
    with open(path, 'r') as f:
        return yaml.safe_load(f)

def get_shared_schemas():
    shared = load_yaml(SHARED_FILE)
    return shared.get('components', {}).get('schemas', {})

def schemas_equal(schema1, schema2):
    return schema1 == schema2

def is_shared_ref(schema_def, schema_name):
    if isinstance(schema_def, dict):
        ref = schema_def.get('$ref', '')
        return ref == f"./shared.yml#/components/schemas/{schema_name}"
    return False

def replace_refs(data, shared_schema_names):
    changed = False
    
    if isinstance(data, dict):
        for key, value in data.items():
            if key == '$ref' and isinstance(value, str):
                if value.startswith('#/components/schemas/'):
                    schema_name = value.split('/')[-1]
                    if schema_name in shared_schema_names:
                        data[key] = f"./shared.yml#/components/schemas/{schema_name}"
                        changed = True
            else:
                if replace_refs(value, shared_schema_names):
                    changed = True
    elif isinstance(data, list):
        for item in data:
            if replace_refs(item, shared_schema_names):
                changed = True
    
    return changed

def remove_duplicate_schemas(spec, shared_schemas):
    removed = []
    if 'components' in spec and 'schemas' in spec.get('components', {}):
        schemas = spec['components']['schemas']
        for schema_name in list(schemas.keys()):
            if schema_name in shared_schemas:
                schema_def = schemas[schema_name]
                if schemas_equal(schema_def, shared_schemas[schema_name]) or is_shared_ref(schema_def, schema_name):
                    del schemas[schema_name]
                    removed.append(schema_name)
    return removed

def main():
    shared_schemas = get_shared_schemas()
    shared_schema_names = set(shared_schemas.keys())
    print(f"Shared schemas: {shared_schema_names}")
    
    spec_files = [f for f in Path(SPECS_DIR).glob("oda-*.yml")]
    
    for spec_file in spec_files:
        print(f"\nProcessing {spec_file.name}...")
        spec = load_yaml(spec_file)
        
        replaced_refs = replace_refs(spec, shared_schema_names)
        removed_schemas = remove_duplicate_schemas(spec, shared_schemas)
        
        if replaced_refs or removed_schemas:
            with open(spec_file, 'w') as f:
                yaml.dump(spec, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
            if removed_schemas:
                print(f"  Removed schemas: {removed_schemas}")
            print(f"  Saved changes")
        else:
            print(f"  No changes needed")

if __name__ == "__main__":
    main()