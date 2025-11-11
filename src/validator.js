/**
 * \returns the `ty` value for the given schema object
 */
function extract_schema_ty(schema)
{
    if ( !schema )
        return;

    if ( "properties" in schema )
    {
        let ty_prop = schema.properties.ty;
        if ( !ty_prop )
            return;
        return ty_prop.const;
    }

    for ( let prop of ["oneOf", "anyOf", "allOf"] )
    {
        if ( schema[prop] )
        {
            for ( let sub_schema of schema[prop] )
            {
                let ty = extract_schema_ty(sub_schema);
                if ( ty !== undefined )
                    return ty;
            }
        }
    }
}

/**
 * \brief User friendly name for errors for a property schema
 */
function get_schema_property_name(schema, pname)
{
    if ( schema.title )
        return " " + schema.title.toLowerCase()
    return "." + pname;
}

/**
 * \brief Adds metadata to the schema to link to the docs
 */
function patch_docs_links(schema, url, name, docs_name, within_properties)
{
    if ( typeof(schema) == "object" )
    {
        if ( Array.isArray(schema) )
        {
            for ( let item of schema )
                patch_docs_links(item, url, name, docs_name);
        }
        else
        {
            for ( let [pname, val] of Object.entries(schema) )
            {
                var sub_name = name;
                if ( within_properties )
                    sub_name += get_schema_property_name(val, pname);

                patch_docs_links(val, url, sub_name, docs_name, pname == "properties");
            }

            if ( !within_properties )
            {
                schema._docs = url;
                schema._docs_name = docs_name;
                schema._name = name;
            }
        }
    }
}

class PropertyList
{
    constructor(schema)
    {
        this.properties = new Set();
        this.references = new Set();
        this.schema = schema;
        this.resolved = false;
        this.skip = false;
    }

    valid()
    {
        return !this.skip && (this.properties.size > 0 || this.references.size > 1);
    }
}

/**
 * \brief Class to gather all properties from a schema in order to warn about missing ones
 */
class PropertyMap
{
    constructor()
    {
        this.map = new Map();
        this.all_references = new Set();
    }

    create(id, schema)
    {
        var map = new PropertyList(schema);
        this.map.set(id, map);
        return map;
    }

    finalize()
    {
        for ( let [name, prop_list] of this.map )
        {
            if ( prop_list.valid() && !this.all_references.has(name) )
                prop_list.schema.warn_extra_props = this._get_all_props(prop_list);
        }
    }

    _get_all_props(prop_list)
    {
        if ( !prop_list.resolved )
        {
            prop_list.resolved = true;
            for ( let ref of prop_list.references )
                for ( let prop of this.get_all_props(ref) )
                    prop_list.properties.add(prop);
        }

        return prop_list.properties;
    }

    get_all_props(id)
    {
        return this._get_all_props(this.map.get(id));
    }

    extract_all_properties(schema, id, prop_list, referencing_base)
    {
        if ( typeof schema != "object" || schema === null )
            return;

        if ( Array.isArray(schema) )
        {
            for ( let i = 0; i < schema.length; i++ )
                this.extract_all_properties(schema[i], id + `/${i}`, prop_list, false);

            return;
        }

        for ( let [name, sub_schema] of Object.entries(schema) )
        {
            if ( name == "properties" )
            {
                for ( let [prop_name, prop] of Object.entries(sub_schema) )
                {
                    prop_list.properties.add(prop_name);
                    let prop_id = id + "/properties/" + prop_name;
                    this.extract_all_properties(prop, prop_id, this.create(prop_id, prop), false);
                }
            }
            else if ( name == "oneOf" )
            {
                for ( let i = 0; i < sub_schema.length; i++ )
                {
                    let oneof_id = id + "/oneOf/" + i;
                    let oneof_schema = sub_schema[i];
                    let oneof_list = id.endsWith("-property") ? prop_list : this.create(oneof_id, oneof_schema);
                    this.extract_all_properties(oneof_schema, oneof_id, oneof_list, false);
                }
            }
            else if ( name == "allOf" )
            {
                for ( let i = 0; i < sub_schema.length; i++ )
                {
                    let oneof_id = id + "/allOf/" + i;
                    let oneof_schema = sub_schema[i];
                    this.extract_all_properties(oneof_schema, oneof_id, prop_list, true);
                }
            }
            else if ( name == "additionalProperties" )
            {
                prop_list.skip = true;
            }
            else if ( name == "$ref" )
            {
                prop_list.references.add(sub_schema);
                if ( referencing_base )
                    this.all_references.add(sub_schema);
            }
            else if ( name != "not" )
            {
                this.extract_all_properties(sub_schema, id + "/" + name, prop_list, false);
            }
        }
    }
}

/**
 * \brief Formats kebab-case to Title Case
 */
function kebab_to_title(kebab)
{
    return kebab.split("-").map(chunk => chunk.charAt(0).toUpperCase() + chunk.substring(1).toLowerCase()).join(" ");
}


/**
 * \brief Validation function to switch OneOf objects based on the value of a property
 * \param propname Name of the property to switch on
 * \param fail_unknown if \b false, generate a warning rather than an error
 * \param default_value Value for the property when missing (if \b undefined an error will be raised when missing)
 */
function custom_discriminator(propname, fail_unknown, default_value=undefined)
{
    function validate_fn(schema, data, parent_schema, data_cxt)
    {
        var value = data[propname]

        // Error will be generated by required
        if ( value === undefined )
        {
            if ( default_value === undefined )
                return true;
            value = default_value;
        }

        var sub_schema = schema[value];
        if ( sub_schema === undefined )
        {
            validate_fn.errors = [{
                message: `has unknown '${propname}' value ` + JSON.stringify(value),
                type: fail_unknown ? "error" : "warning",
                warning: "type",
                instancePath: data_cxt.instancePath + "/" + propname,
                parentSchema: parent_schema,
            }];
            return false;
        }

        var validate = this.getSchema(sub_schema.id);
        if ( !validate(data, data_cxt) )
        {
            validate_fn.errors = validate.errors;
            return false;
        }
        return true;
    }

    return validate_fn;
}

/**
 * \brief Marks the schema to use enum validation
 */
function patch_schema_enum(schema)
{
    if ( "oneOf" in schema )
    {
        delete schema.enum;
        schema.enum_oneof = schema.oneOf;
        delete schema.oneOf;
    }
}

/**
 * \brief Checks if a keyframe object has a numeric \c t property
 */
function keyframe_has_t(kf)
{
    return typeof kf == "object" && typeof kf.t == "number";
}

class LottieValidator
{
    static default_config = {
        name_paths: false,
        docs_url: "https://lottie.github.io/lottie-spec/latest"
    };

    constructor(AjvClass, schema_json, config={})
    {
        for ( let [k, v] of Object.entries(LottieValidator.default_config) )
            if ( config[k] === undefined )
                config[k] = v;

        this.schema = schema_json;
        this.defs = this.schema["$defs"];
        this.name_paths = config.name_paths;
        var prop_map = new PropertyMap();
        let ty_to_patch = [];

        // General patches
        for ( let [cat, sub_schemas] of Object.entries(this.defs) )
        {
            let cat_docs = `${config.docs_url}/specs/${cat}/`;
            let cat_name = kebab_to_title(cat.replace(/s$/, ""));
            for ( let [obj, sub_schema] of Object.entries(sub_schemas) )
            {
                let id = `#/$defs/${cat}/${obj}`;
                this.patch_object(cat, obj, id, sub_schema, cat_docs, cat_name);

                if ( obj.startsWith("all-") && obj != "all-assets" )
                    ty_to_patch.push([cat, obj]);

                prop_map.extract_all_properties(sub_schema, id, prop_map.create(id, sub_schema), false);
            }
        }

        // Go through all the ty-based objects and patch them
        let schema_id = this.schema["$id"];
        for ( let [category, all] of ty_to_patch )
            this._patch_ty_schema(schema_id, category, all);

        // Patch animated property validation to validate based on `a: 0` or `a: 1`
        for ( let [pname, pschema] of Object.entries(this.defs.properties) )
        {
            if ( pname.endsWith("-property") || pname == "gradient-stops" )
                this._patch_property_schema(pschema, schema_id + "#/$defs/properties/" + pname);
        }
        this.defs.properties["base-keyframe"].keyframe = true;

        // Patches enum validation
        for ( let enum_schema of Object.values(this.defs.constants) )
            patch_schema_enum(enum_schema);
        patch_schema_enum(this.defs.values["int-boolean"])

        // Custom validation for assets
        this.defs.assets["all-assets"] = {
            "type": "object",
            "asset_oneof": schema_id,
        };

        for ( let layer_type of ["image-layer", "precomposition-layer"])
        {
            let layer_schema = this.defs.layers[layer_type];
            layer_schema.allOf[1].properties.refId.reference_asset = true;
        }

        prop_map.finalize();

        this.validator = new AjvClass({
            allErrors: true,
            verbose: true,
            // inlineRefs: false,
            // strict: false,
            keywords: this.custom_validator_keywords(),
            schemas: [this.schema]
        });
        this._validate_internal = this.validator.getSchema(schema_id);
    }

    /**
     * \brief Returns an array for Ajv `keywords`
     */
    custom_validator_keywords()
    {
        let self = this;
        return [
            // Ignore custom validators and $version
            {keyword: ["_docs", "_name", "_docs_name", "$version"]},
            // ty-based validation switch
            {
                keyword: "ty_oneof",
                validate: custom_discriminator("ty", false),
            },
            // animated property based on `a`
            {
                keyword: "prop_oneof",
                validate: custom_discriminator("a", true),
            },
            // Asset validation switch based on structure
            {
                keyword: "asset_oneof",
                validate: function validate_asset(schema, data, parent_schema, data_cxt)
                {
                    validate_asset.errors = [];

                    if ( typeof data != "object" || data === null )
                        return true;

                    var target_schema = this.getSchema(schema + self.get_asset_ref(data));

                    if ( !target_schema(data, data_cxt) )
                    {
                        validate_asset.errors = target_schema.errors;
                        return false;
                    }
                    return true;
                },
            },
            // Split position based on `s`
            {
                keyword: "splitpos_oneof",
                validate: custom_discriminator("s", false, false),
            },
            // Keyframe validation for structure and semantics
            {
                keyword: "keyframe",
                validate: function validate_keyframe(schema, data, parent_schema, data_cxt)
                {
                    validate_keyframe.errors = [];

                    var require_io = true;
                    if ( data.h )
                        require_io = false;

                    var index = data_cxt.parentData.indexOf(data);
                    if ( index == data_cxt.parentData.length - 1 )
                        require_io = false;

                    if ( require_io )
                    {
                        for ( var prop of "io" )
                        {
                            if ( !("i" in data) )
                            {
                                validate_keyframe.errors.push({
                                    message: `must have required property 'i'`,
                                    type: "error",
                                    instancePath: data_cxt.instancePath,
                                    parentSchema: parent_schema,
                                });
                            }
                        }
                    }

                    if ( index > 0 )
                    {
                        var prev_kf = data_cxt.parentData[index-1];
                        if ( keyframe_has_t(prev_kf) && typeof data.t == "number" )
                        {
                            if ( data.t < prev_kf.t )
                            {
                                validate_keyframe.errors.push({
                                    message: `keyframe 't' must be in ascending order`,
                                    type: "error",
                                    instancePath: data_cxt.instancePath,
                                    parentSchema: parent_schema,
                                });
                            }
                            else if ( data.t == prev_kf.t && index > 1 )
                            {
                                var prev_prev = data_cxt.parentData[index-2];
                                if ( keyframe_has_t(prev_prev) && data.t == prev_prev.t )
                                {
                                    validate_keyframe.errors.push({
                                        message: `there can be at most 2 keyframes with the same 't' value`,
                                        type: "error",
                                        instancePath: data_cxt.instancePath,
                                        parentSchema: parent_schema,
                                    });
                                }
                            }
                        }
                    }

                    return validate_keyframe.errors.length == 0;
                }
            },
            // More user-friendly error for enums
            {
                keyword: "enum_oneof",
                validate: function validate_enum(schema, data, parent_schema, data_cxt)
                {
                    validate_enum.errors = [];
                    for ( let value of schema )
                        if ( value.const === data )
                            return true;

                    validate_enum.errors.push({
                        message: `'${data}' is not a valid enumeration value`,
                        type: "error",
                        instancePath: data_cxt.instancePath,
                        parentSchema: parent_schema,
                    });
                    return false;
                },
            },
            // Validate layers refId point to valid assets
            {
                keyword: "reference_asset",
                validate: function validate_asset_reference(schema, data, parent_schema, data_ctx)
                {
                    validate_asset_reference.errors = [];

                    if ( Array.isArray(data_ctx.rootData.assets) )
                    {
                        for ( let asset of data_ctx.rootData.assets )
                        {
                            if ( asset.id === data )
                            {
                                // TODO: Validate asset type?
                                return true;
                            }
                        }
                    }

                    validate_asset_reference.errors.push({
                        message: `${JSON.stringify(data)} is not a valid asset id`,
                        type: "error",
                        instancePath: data_ctx.instancePath,
                        parentSchema: parent_schema,
                    });
                    return false;
                },
            },
            // Adds warnings for unknown properties
            {
                keyword: "warn_extra_props",
                validate: function warn_extra_props(schema, data, parent_schema, data_cxt)
                {
                    warn_extra_props.errors = [];

                    if ( typeof data != "object" || data === null )
                        return true;

                    for ( let prop of Object.keys(data) )
                    {
                        if ( !schema.has(prop) )
                        {
                            warn_extra_props.errors.push({
                                message: `has unknown property '${prop}'`,
                                type: "warning",
                                warning: "property",
                                instancePath: data_cxt.instancePath + "/" + prop,
                                parentSchema: parent_schema,
                            });
                        }
                    }

                    return warn_extra_props.errors.length == 0;
                },
            },
        ];
    }

    /**
     * \returns the $ref link of an asset based on its data (to determine the right validator)
     */
    get_asset_ref(data)
    {
        if ( "layers" in data )
            return "#/$defs/assets/precomposition";
        return "#/$defs/assets/image";

    }

    /**
     * \brief Applies common patches to a schema object
     * \param cat Category slug
     * \param obj Class slug
     * \param ref $ref for the object
     * \param obj_schema Class schema
     * \param cat_docs Category docs link
     * \param cat_name Category title
     */
    patch_object(cat, obj, ref, obj_schema, cat_docs, cat_name)
    {
        let obj_docs = cat_docs;
        let obj_name = cat_name;
        if ( obj_schema.type && obj != "base-gradient" )
        {
            obj_docs += "#" + obj;
            obj_name = obj_schema.title || kebab_to_title(obj);
        }
        patch_docs_links(obj_schema, obj_docs, obj_name, obj_name);
    }

    /**
     * \brief Adds `ty`-based validation on `all-*` schemas
     */
    _patch_ty_schema(id_base, category, all)
    {

        let found = {};
        for ( let [name, sub_schema] of Object.entries(this.defs[category]) )
        {
            let ty = extract_schema_ty(sub_schema);
            if ( ty !== undefined )
            {
                let id = `${id_base}#/$defs/${category}/${name}`;
                found[ty] = {
                    id: id
                };
            }
        }
        this.defs[category][all].ty_oneof = found;
        delete this.defs[category][all].oneOf;

        return found;
    }

    /**
     * \brief Patches animated property validation to validate based on `a: 0` or `a: 1`
     */
    _patch_property_schema(schema, id)
    {
        if ( id.endsWith("gradient-property") )
        {
            if ( schema.properties.k.$ref )
                return schema;
            return this._patch_property_schema(schema.properties.k, id + "/properties/k");
        }


        if ( id.endsWith("splittable-position-property") )
        {
            delete schema.oneOf;
            schema.splitpos_oneof = {
                [true]: {id: this.schema["$id"] + "#/$defs/properties/split-position"},
                [false]: {id: this.schema["$id"] + "#/$defs/properties/position-property"},
            };

            return;
        }

        schema.prop_oneof = [];
        for ( let opt of schema.oneOf )
        {
            schema.prop_oneof.push({
                schema: {
                    type: "object",
                    ...opt
                },
                id: id + "/prop_oneof/" + schema.prop_oneof.length + "/schema",
            });
        }
        delete schema.oneOf;
    }

    /**
     * \brief Validates an object
     * \param data Object to validate
     * \param show_warnings If \b true, warnings will be returned, otherwise just errors
     * \returns Array of errors
     */
    validate_object(data, show_warnings=true)
    {
        let errors = [];
        if ( !this._validate_internal(data) )
        {
            errors = this._validate_internal.errors
                .map(e => this._cleaned_error(e, data, show_warnings))
                .filter(e => e !== null)
        };

        return errors.sort((a, b) => {
            if ( a.path < b.path )
                return -1;
            if ( a.path > b.path )
                return 1;
            return 0;
        });
    }

    /**
     * \brief Validates an object
     * \param data Object or JSON string to validate
     * \param show_warnings If \b true, warnings will be returned, otherwise just errors
     * \returns Array of errors
     */
    validate(data, show_warnings=true)
    {
        if ( typeof data == "string" )
            return this.validate_string(data, show_warnings);
        return this.validate_object(data, show_warnings);
    }

    /**
     * \brief Validates a JSON string
     * \param data JSON string to validate
     * \param show_warnings If \b true, warnings will be returned, otherwise just errors
     * \returns Array of errors
     */
    validate_string(string, show_warnings=true)
    {
        var data;
        try {
            data = JSON.parse(string);
        } catch(e) {
            return [
                {
                    type: "error",
                    message: "Document is not a valid JSON file",
                },
                {
                    type: "error",
                    message: e.message,
                }
            ];
        }

        return this.validate_object(data, show_warnings);
    }

    /**
     * \brief Processes an Ajv error and returns a friendlier object
     * \param error Ajv error object
     * \param data Top-level object being validated
     * \param show_warnings Whether to include warnings
     * \return A structured error object containing docs metadata
     *         or \b null if the error is to be ignored
     */
    _cleaned_error(error, data, show_warnings)
    {
        if ( !show_warnings && error.type === "warning" )
            return null;

        // There's going to be other errors on failed ifs
        if ( error.keyword == "if" )
            return null;

        if ( error.keyword == "pattern" )
            error.message = "doesn't match the pattern";

        let path_names;
        if ( this.name_paths )
        {
            const path_parts = error.instancePath.split("/");
            path_names = [];
            for ( const path_part of path_parts )
            {
                if ( path_part === "#" || path_part === "" )
                    continue;

                data = data[path_part];

                if ( !data )
                    break;

                // Every layer with a type may be named
                // Push a null value if it doesn't exist so display code can handle
                if ( data.ty )
                    path_names.push(data.nm);
            }
        }

        return {
            type: error.type ?? "error",
            warning: error.warning,
            message: (error.parentSchema?._name ?? "Value") + " " + error.message,
            path: error.instancePath ?? "",
            name: error.parentSchema?._docs_name ?? "Value",
            docs: error.parentSchema?._docs,
            path_names: path_names,
        };
    }
}

/**
 * \returns the file name for the schema based on the given parameters
 * \param version Schema version eg: `1.0`
 */
function schema_file_name(version=null)
{
    return "lottie.schema.json";
}

/**
 * \returns URL of the schema
 * \param url_prefix CDN to use
 */
function get_schema_url(version=null, url_prefix="https://cdn.jsdelivr.net/npm/@lottie-animation-community/lottie-specs/src/data/")
{
    return url_prefix + schema_file_name(version);
}

// Node module exports
if ( typeof module !== "undefined" )
{
    module.exports = {LottieValidator, get_schema_url, schema_file_name};
}
