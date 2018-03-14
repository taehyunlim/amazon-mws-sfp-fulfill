'use strict';
var fs = require('fs');
var path = require('path');
var moment = require('moment');

var utils = module.exports = {

    // isAuthKey: function (key) {
    //     return typeof key === 'string' && /^(?:[a-z]{2}_)?[A-z0-9]{32}$/.test(key);
    // },
    //
    // isOptionsHash: function (o) {
    //     return _.isPlainObject(o) && ['api_key'].some(function (key) {
    //           return o.hasOwnProperty(key);
    //       });
    // },
    //
    // /**
    //  * Stringifies an Object, accommodating nested objects
    //  * (forming the conventional key 'parent[child]=value')
    //  */
    // stringifyRequestData: function (data) {
    //     return qs.stringify(data, {arrayFormat: 'brackets'});
    // },

    // Re-creating fs.existsSync
    fsExistsSync: (dir) => {
      try {
        fs.accessSync(dir);
        return true;
      } catch (e) {
        return false;
      }
    },

    // Sorting util function for finding cheapest rate service available
    sortByKeyValue: (prop, arr) => {
        prop = prop.split('.');
        var len = prop.length;

        arr.sort(function (a, b) {
            var i = 0;
            while( i < len ) {
                a = a[prop[i]];
                b = b[prop[i]];
                i++;
            }
            if (parseFloat(a) < parseFloat(b)) {
                return -1;
            } else if (parseFloat(a) > parseFloat(b)) {
                return 1;
            } else {
                return 0;
            }
        });
        return arr;
    },

    // // Create directory if DNE
    // initializeDirectory: (dirInput) => {
    //   var dirName = path.dirname(dirInput);
    //   if (fs.existsSync(dirName)) { return true; }
    //   initializeDirectory(dirName);
    //   fs.mkdirSync(dirName);
    // },

    // Takes in SKU as key and returns dimensions
    findDimsBySku: (key, array) => {
      for (var i = 0; i < array.length; i++) {
        if (array[i].SKU === key ) {
          let dimsWt = {
            "dimSKU": array[i].SKU,
            "dimL": array[i].length,
            "dimW": array[i].width,
            "dimH": array[i].height,
            "dimUnit": "inches",
            "wValue": array[i].weight_oz,
            "wUnit": "oz"
          }
          return dimsWt;
        }
      }
    },

    findReleaseDimsBySku: (keySKU, array) => {
      for (var i = 0; i < array.length; i++) {
        if (array[i]['Item Number'] === keySKU) {
          let weight_in_oz = Math.ceil(parseFloat(array[i]['Package Weight']) * 16);
          let dimsWt = {
            "dimSKU": array[i]['Item Number'],
            "dimL": array[i]['Package Length'],
            "dimW": array[i]['Package Width'],
            "dimH": array[i]['Package Height'],
            "dimUnit": "inches",
            "wValue": weight_in_oz,
            "wUnit": "oz"
          }
          return dimsWt;
        }
      }
    },

    // Take in origin SKU as key and returns subs SKU
    findSubSKU: (key, array) => {
      if (array.length == 0) {
        return key;
      } else {
        for (var i = 0; i < array.length; i++) {
          if (array[i].origin === key ) {
            return array[i].sub;
          } else { return key; }
        }
      }
    },

};
