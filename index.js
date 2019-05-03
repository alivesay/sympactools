'use strict';

//     _______  ______ ___  ____  ____ ______/ /_____  ____  / /____
//    / ___/ / / / __ `__ \/ __ \/ __ `/ ___/ __/ __ \/ __ \/ / ___/
//   (__  ) /_/ / / / / / / /_/ / /_/ / /__/ /_/ /_/ / /_/ / (__  ) 
//  /____/\__, /_/ /_/ /_/ .___/\__,_/\___/\__/\____/\____/_/____/  
//       /____/         /_/                                         

const axios = require('axios');
const express = require('express');
const { checkSchema, validationResult } = require('express-validator/check');
const morgan = require('morgan');

// SETUP //////////////////////////////////////////////////////////////////////
const config = require('./config.json');
const app = express();

const ILSWS_BASE_URI = `https://${config.ILSWS_HOSTNAME}:${config.ILSWS_PORT}/${config.ILSWS_WEBAPP}`;
const ILSWS_ORIGINATING_APP_ID = 'sympactools';

app.use(express.json());
app.use(morgan('combined'));
app.use((error, req, res, next) => {
  res.status(500).send({ error: error.toString() });
});

axios.defaults.headers.common['sd-originating-app-id'] = ILSWS_ORIGINATING_APP_ID;
axios.defaults.headers.common['x-sirs-clientID'] = config.ILSWS_CLIENTID;
axios.defaults.headers.common['Accept'] = 'application/json';
axios.defaults.headers.common['Content-Type'] = 'application/json';

// ROUTES /////////////////////////////////////////////////////////////////////
app.post('/login', checkSchema(buildSchemaDefault([
  'code',
  'pin'
])), requestValidationHandler, (req, res) => {
  return ILSWS_patronLogin(req.body.code, req.body.pin)
  .then(() => res.send({ message: 'authenticated' }))
  .catch(responseErrorHandler(res));
});

app.post('/pin_reset', checkSchema(buildSchemaDefault([
  'code'
])), requestValidationHandler, (req, res) => {
  return ILSWS_patronResetPin(req.body.code)
  .then(() => res.send({ message: 'pin reset' }))
  .catch(responseErrorHandler(res));
});

app.post('/modify_contact_info', checkSchema(buildSchemaDefault([
  'code',
  'pin',
  'address1_street',
  'address1_city',
  'address1_state',
  'address1_zip',
  'email',
  'telephone',
  'location_code'
])), requestValidationHandler, (req, res) => {
  Object.keys(req.body).forEach(key => !req.body[key] && delete req.body[key]);
  
  return ILSWS_patronLogin(req.body.code, req.body.pin)
  .then(loginResponse => loginResponse.data)
  .then(loginData => Promise.all([
    loginData,
    ILSWS_patronFetch(loginData.sessionToken, loginData.patronKey)
  ]))
  .then(([loginData, patronResponse]) => Promise.all([loginData, patronResponse.data]))
  .then(([loginData, patronData]) => {
    
    patronData.fields.library = {
      resource: '/policy/library',
      key: req.body.location_code.toUpperCase()
    };

    [['STREET', req.body.address1_street],
     ['CITY/STATE', `${req.body.address1_city}, ${req.body.address1_state}`],
     ['ZIP', req.body.address1_zip],
     ['EMAIL', req.body.email],
     ['PHONE', req.body.telephone]].forEach(v => {
       for (const f of patronData.fields.address1) {
         if (f.fields && f.fields.code && f.fields.code.key === v[0] && v[1])
           f.fields.data = v[1];
       }
    });

    return ILSWS_patronUpdate(loginData.sessionToken, patronData);
  })
  .then(() => res.send({ message: 'contact info updated'}))
  .catch(responseErrorHandler(res));
});

app.post('/register', checkSchema(buildSchemaDefault([
  'first_name',
  'middle_name',
  'last_name',
  'birthdate',
  'address1_street',
  'address1_city',
  'address1_state',
  'address1_zip',
  'address2_street',
  'address2_city',
  'address2_state',
  'address2_zip',
  'email',
  'telephone',
  'pin'
])), requestValidationHandler, (req, res) => {
  const b = req.body, patronData = {
    'patron-firstName': b.first_name,
    'patron-middleName': b.middle_name,
    'patron-lastName': b.last_name,
    'patron-birthDate': b.birthdate,
    'patronAddress1-STREET': b.address1_street,
    'patronAddress1-CITY': b.address1_city,
    'patronAddress1-STATE': b.address1_state,
    'patronAddress1-ZIP': b.address1_zip,
    'patronAddress1-EMAIL': b.email,
    'patronAddress1-PHONE': b.telephone,
    'patronAddress2-STREET': b.address2_street,
    'patronAddress2-CITY': b.address2_city,
    'patronAddress2-STATE':  b.address2_state,
    'patronAddress2-ZIP': b.address2_zip,
    'patron-pin': b.pin,
    'patron-confirmPIN': b.pin
  };

  for (const cat in config.ILSWS_PATRON_CATEGORY_DEFAULTS) {
    if (config.ILSWS_PATRON_CATEGORY_DEFAULTS.hasOwnProperty(cat)) {
      patronData[`patron-category${cat}`] = {
        resource: `/policy/patronCategory${cat}`,
        key: config.ILSWS_PATRON_CATEGORY_DEFAULTS[cat].key,
        fields: {
          displayName: config.ILSWS_PATRON_CATEGORY_DEFAULTS[cat].displayName
        }
      };
    }
  }

  return ILSWS_patronRegister(patronData)
  .then(registerResponse => registerResponse.data)
  .then(registerData => {
    if (config.ILSWS_LANGUAGE_ENABLED !== true) {
      return res.send({message: 'patron registered', barcode: registerData.barcode});
    }
    
    return ILSWS_patronLogin(registerData.barcode, req.body.pin)
    .then(loginResponse => loginResponse.data)
    .then(loginData => Promise.all([
      loginData,
      ILSWS_patronFetch(loginData.sessionToken, loginData.patronKey)
    ]))
    .then(([loginData, fetchResponse]) => Promise.all([loginData, fetchResponse.data]))
    .then(([loginData, fetchData]) => {
      fetchData.fields[config.ILSWS_LANGUAGE_FIELD] = {
        resource: '/policy/language',
        key: config.ILSWS_LANGUAGE_DEFAULT_KEY
      };

      return Promise.all([loginData, fetchData]);
    })
    .then(([loginData, fetchData]) => ILSWS_patronUpdate(loginData.sessionToken, fetchData))
    .then(() => res.send({message: 'patron registered', barcode: registerData.barcode}));
  })
  .catch(responseErrorHandler(res));
});

app.post('/change_pin', checkSchema(buildSchemaDefault([
  'code',
  'pin',
  'new_pin'
])), requestValidationHandler, (req, res) => {
  return Promise.resolve(req.query.callback ? null : ILSWS_patronLogin(req.body.code, req.body.pin))
  .then(loginResponse => ILSWS_patronChangeMyPin(loginResponse && loginResponse.data.sessionToken, req.body.pin, req.body.new_pin, req.query.callback))
  .then(() => res.send({message: 'pin changed'}))
  .catch(responseErrorHandler(res));
});

app.get('/contact_info', checkSchema({
  code: { in: [ 'query' ], exists: true, errorMessage: 'field required' },
  pin: { in: [ 'query' ], exists: true, errorMessage: 'field required' }
}), requestValidationHandler, (req, res) => {
  return ILSWS_patronLogin(req.query.code, req.query.pin)
  .then(loginResponse => loginResponse.data)
  .then(loginData => ILSWS_patronFetch(loginData.sessionToken, loginData.patronKey))
  .then(fetchResponse => res.send(convertPatronToContact(fetchResponse.data)))
  .catch(responseErrorHandler(res));
});

app.post('/acquire', checkSchema(buildSchemaDefault([
  'code',
  'pin',
  'author',
  'title',
  'publisher',
  'isbn',
  'type',
  'subject'
])), requestValidationHandler, (req, res) => {
  return ILSWS_patronLogin(req.body.code, req.body.pin)
  .then(loginResponse => loginResponse.data)
  .then(() => res.status(501).send({ error: 'not implemented yet' }))
  .catch(responseErrorHandler(res));
});

// ILSWS REQUEST HANDLERS /////////////////////////////////////////////////////
function ILSWS_patronLogin(barcode, pin) {
  return axios({
    method: 'POST',
    url: `${ILSWS_BASE_URI}/user/patron/login`,
    data: {
      login: barcode,
      password: pin
    }
  });
}

function ILSWS_patronChangeMyPin(token, currentPin, newPin, callback) {
  const headers = { ...(!callback && { 'x-sirs-sessionToken': token}) };

  return axios({
    method: 'POST',
    url: `${ILSWS_BASE_URI}/user/patron/changeMyPin`,
    data: Object.assign({},
      { newPin: newPin },
      callback && { resetPinToken: currentPin },
      !callback && { currentPin: currentPin }),
    headers: headers
  });
}

function ILSWS_patronRegister(patronData) {
  return axios({
    method: 'POST',
    url: `${ILSWS_BASE_URI}/user/patron/register`,
    data: patronData
  });
}

function ILSWS_patronUpdate(token, patronData) {
  return axios({
    method: 'PUT',
    url: `${ILSWS_BASE_URI}/user/patron/key/${patronData.key}`,
    data: patronData,
    headers: {
      'x-sirs-sessionToken': token
    }
  });
}

function ILSWS_patronFetch(token, key) {
  const includeFields = [
    'barcode',
    'birthDate',
    'firstName',
    'middleName',
    'lastName',
    'library',
    'address1'
  ];

  for (const cat in config.ILSWS_PATRON_CATEGORY_DEFAULTS) {
    if (config.ILSWS_PATRON_CATEGORY_DEFAULTS.hasOwnProperty(cat))
      includeFields.push(`category${cat}`); 
  }

  if (config.ILSWS_LANGUAGE_ENABLED === true) includeFields.push('language');

  return axios({
    method: 'GET',
    url: `${ILSWS_BASE_URI}/user/patron/key/${key}`,
    params: {
      includeFields: includeFields.join()
    },
    headers: {
      'x-sirs-sessionToken': token
    }
  });
}

function ILSWS_patronResetPin(barcode) {
  return axios({
    method: 'POST',
    url: `${ILSWS_BASE_URI}/user/patron/resetMyPin`,
    data: {
      barcode: barcode,
      resetPinUrl: `${config.ILSWS_RESET_PIN_URL}?resetPinToken=<RESET_PIN_TOKEN>`
    }
  });
}

// HELPERS ////////////////////////////////////////////////////////////////////
function requestValidationHandler(req, res, next) {
  const vErrors = validationResult(req);
  if (!vErrors.isEmpty()) {
    return res.status(400).json({
      error: 'missing required fields: ' + vErrors.array().map(e => e.param).join()
    });
  }
  return next();
}

function responseErrorHandler(res) {
  return (error) => {
    if (typeof error.response === 'undefined' || error.response.status !== 401) {
      return res.status(500).send({ error: 'internal server error' });
    }

    res.status(401).send({ error: 'login failed' });
  };
}

function buildSchemaDefault(fields) {
  return Object.assign({}, ...fields.map(field => ({
    [field]: { in: ['body'], exists: true, errorMessage: 'field required' }
  })));
}

function convertPatronToContact(data) {
  const _ak = (key) => {
    for (const f of data.fields.address1) {
      if (f.fields && f.fields.code && f.fields.code.key === key)
        return f.fields.data;
    }
    return '';
  };

  const [city, state] = _ak('CITY/STATE').split(/,(?=[^,]+$)/);

  return {
    address1_street: _ak('STREET'),
    address1_city: city.trim(),
    address1_state: state.trim(),
    address1_zip: _ak('ZIP'),
    email: _ak('EMAIL'),
    telephone: _ak('PHONE'),
    location_code: data.fields.library.key
  };
}

// o_O ////////////////////////////////////////////////////////////////////////
app.listen(config.SYMPAC_PORT, () => {
  console.log(`Listening on ${config.SYMPAC_PORT}`);
});
