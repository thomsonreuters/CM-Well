/**
  * Copyright 2015 Thomson Reuters
  *
  * Licensed under the Apache License, Version 2.0 (the “License”); you may not use this file except in compliance with the License.
  * You may obtain a copy of the License at
  *
  *   http://www.apache.org/licenses/LICENSE-2.0
  *
  * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on
  * an “AS IS” BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  *
  * See the License for the specific language governing permissions and
  * limitations under the License.
  */

package cmwell.util.string.test

import java.io.{ByteArrayInputStream, InputStream}

import org.scalatest.{FunSpec, Matchers}
import cmwell.util.string._

class StringTests extends FunSpec with Matchers {
  private def mkString(is: InputStream) = scala.io.Source.fromInputStream(is).mkString

  describe("mapInputStreamLines should") {
    it("return empty for empty input") {
      val emptyInput = new ByteArrayInputStream(Array.emptyByteArray)
      val result = mapInputStreamLines(emptyInput)(identity)
      result.read() should be(-1)
    }
    it("provide the delimiter as well") {
      val delim = '\n'
      val s = "provide the\ndelimiter as well"
      val expectedAmount = s.count(delim.==)

      val input = stringToInputStream(s)
      val result = mapInputStreamLines(input)(_.toUpperCase)
      mkString(result).count(delim.==) should be(expectedAmount)
    }
    it("not end with the delimiter") {
      val input = stringToInputStream("not end with\nthe delimiter")
      val result = mapInputStreamLines(input)(_.toUpperCase)
      mkString(result).last should be('R')
    }
    it("handle a concat mapper") {
      val input = stringToInputStream("handle\na\nconcat\nmapper")
      val result = mapInputStreamLines(input)(_ + " not")
      mkString(result) should be("handle not\na not\nconcat not\nmapper not")
    }
  }

}